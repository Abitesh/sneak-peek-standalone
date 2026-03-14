#![deny(clippy::all)]

#[macro_use]
extern crate napi_derive;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode, ErrorStrategy};
use ringbuf::traits::Consumer;
use webrtc_vad::{Vad, SampleRate as VadSampleRate, VadMode};

pub mod vad; 
pub mod microphone;
pub mod speaker;
pub mod streaming_resampler;
pub mod audio_config;
pub mod silence_suppression;

// Keep old resampler module for compatibility
pub mod resampler;

use crate::streaming_resampler::StreamingResampler;
use crate::audio_config::{FRAME_SAMPLES, DSP_POLL_MS};
use crate::silence_suppression::{
    SilenceSuppressor, SilenceSuppressionConfig, FrameAction, generate_silence_frame
};

// ============================================================================
// SYSTEM AUDIO CAPTURE (ScreenCaptureKit on macOS)
// ============================================================================

#[napi]
pub struct SystemAudioCapture {
    stop_signal: Arc<AtomicBool>,
    capture_thread: Option<thread::JoinHandle<()>>,
    sample_rate: u32,
    device_id: Option<String>,
}

#[napi]
impl SystemAudioCapture {
    #[napi(constructor)]
    pub fn new(device_id: Option<String>) -> napi::Result<Self> {
        println!("[SystemAudioCapture] Created (device: {:?})", device_id);
        
        Ok(SystemAudioCapture {
            stop_signal: Arc::new(AtomicBool::new(false)),
            capture_thread: None,
            sample_rate: 16000,
            device_id,
        })
    }

    #[napi]
    pub fn get_sample_rate(&self) -> u32 {
        self.sample_rate
    }

    #[napi]
    pub fn start(&mut self, callback: JsFunction, on_speech_ended: Option<JsFunction>) -> napi::Result<()> {
        let tsfn: ThreadsafeFunction<Vec<i16>, ErrorStrategy::Fatal> = callback
            .create_threadsafe_function(0, |ctx| {
                let vec: Vec<i16> = ctx.value;
                let mut pcm_bytes = Vec::with_capacity(vec.len() * 2);
                for sample in vec {
                    pcm_bytes.extend_from_slice(&sample.to_le_bytes());
                }
                Ok(vec![pcm_bytes])
            })?;

        // Optional speech-ended callback
        let speech_ended_tsfn: Option<ThreadsafeFunction<bool, ErrorStrategy::Fatal>> = match on_speech_ended {
            Some(f) => Some(f.create_threadsafe_function(0, |ctx| {
                Ok(vec![ctx.value])
            })?),
            None => None,
        };

        self.stop_signal.store(false, Ordering::SeqCst);
        let stop_signal = self.stop_signal.clone();
        let device_id = self.device_id.take();
        
        // ★ ALL init + DSP runs in background thread — start() returns INSTANTLY
        // This prevents the 5-7 second main-thread block from SCK initialization.
        // GCD completion handlers in SpeakerInput::new() work from background threads.
        self.capture_thread = Some(thread::spawn(move || {
            // 1. SCK Init (takes 5-7 seconds — runs OFF main thread)
            println!("[SystemAudioCapture] Background init starting...");
            let input = match speaker::SpeakerInput::new(device_id) {
                Ok(i) => i,
                Err(e) => {
                    println!("[SystemAudioCapture] Init failed: {}. Trying default...", e);
                    match speaker::SpeakerInput::new(None) {
                        Ok(i) => i,
                        Err(e2) => {
                            eprintln!("[SystemAudioCapture] FATAL: All init attempts failed: {}", e2);
                            return;
                        }
                    }
                }
            };
            
            let mut stream = input.stream();
            let input_sample_rate = stream.sample_rate() as f64;
            let mut consumer = match stream.take_consumer() {
                Some(c) => c,
                None => {
                    eprintln!("[SystemAudioCapture] FATAL: Failed to get consumer");
                    return;
                }
            };
            
            println!("[SystemAudioCapture] Background init complete. Rate: {}Hz. DSP starting.", input_sample_rate);

            // 2. DSP loop with silence suppression
            let mut resampler = StreamingResampler::new(input_sample_rate, 16000.0);
            let mut frame_buffer: Vec<i16> = Vec::with_capacity(FRAME_SAMPLES * 4);
            let mut raw_batch: Vec<f32> = Vec::with_capacity(4096);
            
            let mut suppressor = SilenceSuppressor::new(
                SilenceSuppressionConfig::for_system_audio()
            );

            // WebRTC VAD for voice vs noise discrimination (created in-thread because !Send)
            let mut webrtc_vad = Vad::new_with_rate_and_mode(
                VadSampleRate::Rate16kHz,
                VadMode::VeryAggressive,
            );

            // Track whether VAD confirmed any real voice since last silence period.
            // This prevents phantom speech_ended events from non-voice noise (Bug #1).
            let mut vad_confirmed_voice = false;

            loop {
                if stop_signal.load(Ordering::Relaxed) {
                    break;
                }
                
                // Drain ring buffer (lock-free)
                while let Some(sample) = consumer.try_pop() {
                    raw_batch.push(sample);
                    if raw_batch.len() >= 480 {
                        break;
                    }
                }
                
                // Resample
                if !raw_batch.is_empty() {
                    let resampled = resampler.resample(&raw_batch);
                    frame_buffer.extend(resampled);
                    raw_batch.clear();
                }

                // Process frames with Silence Suppression
                while frame_buffer.len() >= FRAME_SAMPLES {
                    let frame: Vec<i16> = frame_buffer.drain(0..FRAME_SAMPLES).collect();
                    let (action, speech_just_ended) = suppressor.process(&frame);
                    
                    match action {
                        FrameAction::Send(ref audio) => {
                            // Check if this is a hangover frame (below threshold but in grace period)
                            // Hangover frames should NOT be VAD-checked — they preserve word endings (Bug #4)
                            let rms = audio.iter().map(|&s| (s as f64) * (s as f64)).sum::<f64>() / audio.len() as f64;
                            let is_hangover = rms.sqrt() < suppressor.adaptive_threshold() as f64;
                            
                            if is_hangover {
                                // Hangover frame: send as-is to preserve trailing audio
                                tsfn.call(audio.clone(), ThreadsafeFunctionCallMode::NonBlocking);
                            } else {
                                // Active speech frame: WebRTC VAD checks if it's actual human voice
                                let is_voice = webrtc_vad.is_voice_segment(audio).unwrap_or(true);
                                if is_voice {
                                    vad_confirmed_voice = true;
                                    tsfn.call(audio.clone(), ThreadsafeFunctionCallMode::NonBlocking);
                                } else {
                                    // RMS was high but VAD says not voice (keyboard, cough, etc.)
                                    tsfn.call(generate_silence_frame(FRAME_SAMPLES), ThreadsafeFunctionCallMode::NonBlocking);
                                }
                            }
                        },
                        FrameAction::SendSilence => {
                             tsfn.call(generate_silence_frame(FRAME_SAMPLES), ThreadsafeFunctionCallMode::NonBlocking);
                        },
                        FrameAction::Suppress => {
                            // Do nothing (bandwidth saving)
                        }
                    }

                    // Fire speech_ended ONLY if VAD confirmed at least one real voice frame (Bug #1)
                    if speech_just_ended && vad_confirmed_voice {
                        if let Some(ref se_tsfn) = speech_ended_tsfn {
                            se_tsfn.call(true, ThreadsafeFunctionCallMode::NonBlocking);
                        }
                        vad_confirmed_voice = false; // Reset for next speech segment
                    } else if speech_just_ended {
                        // Was noise, not voice — reset without firing callback
                        vad_confirmed_voice = false;
                    }
                }
                
                // Short sleep
                if frame_buffer.len() < FRAME_SAMPLES {
                    thread::sleep(Duration::from_millis(DSP_POLL_MS));
                }
            }
            
            println!("[SystemAudioCapture] DSP thread stopped.");
            // stream is dropped here → SpeakerStream::Drop calls stop_with_ch
        }));

        Ok(())
    }

    #[napi]
    pub fn stop(&mut self) {
        self.stop_signal.store(true, Ordering::SeqCst);
        if let Some(handle) = self.capture_thread.take() {
            let _ = handle.join();
        }
    }
}

// ============================================================================
// MICROPHONE CAPTURE (CPAL)
// ============================================================================

#[napi]
pub struct MicrophoneCapture {
    stop_signal: Arc<AtomicBool>,
    capture_thread: Option<thread::JoinHandle<()>>,
    sample_rate: u32,
    input: Option<microphone::MicrophoneStream>,
}

#[napi]
impl MicrophoneCapture {
    #[napi(constructor)]
    pub fn new(device_id: Option<String>) -> napi::Result<Self> {
        let input = match microphone::MicrophoneStream::new(device_id) {
            Ok(i) => i,
            Err(e) => return Err(napi::Error::from_reason(format!("Failed: {}", e))),
        };
        
        let sample_rate = 16000;

        Ok(MicrophoneCapture {
            stop_signal: Arc::new(AtomicBool::new(false)),
            capture_thread: None,
            sample_rate,
            input: Some(input),
        })
    }

    #[napi]
    pub fn get_sample_rate(&self) -> u32 {
        self.sample_rate
    }

    #[napi]
    pub fn start(&mut self, callback: JsFunction, on_speech_ended: Option<JsFunction>) -> napi::Result<()> {
        let tsfn: ThreadsafeFunction<Vec<i16>, ErrorStrategy::Fatal> = callback
            .create_threadsafe_function(0, |ctx| {
                let vec: Vec<i16> = ctx.value;
                let mut pcm_bytes = Vec::with_capacity(vec.len() * 2);
                for sample in vec {
                    pcm_bytes.extend_from_slice(&sample.to_le_bytes());
                }
                Ok(vec![pcm_bytes])
            })?;

        // Optional speech-ended callback
        let speech_ended_tsfn: Option<ThreadsafeFunction<bool, ErrorStrategy::Fatal>> = match on_speech_ended {
            Some(f) => Some(f.create_threadsafe_function(0, |ctx| {
                Ok(vec![ctx.value])
            })?),
            None => None,
        };

        self.stop_signal.store(false, Ordering::SeqCst);
        let stop_signal = self.stop_signal.clone();
        
        let input_ref = self.input.as_mut()
            .ok_or_else(|| napi::Error::from_reason("Input missing"))?;
        
        input_ref.play().map_err(|e| napi::Error::from_reason(format!("{}", e)))?;
        
        let input_sample_rate = input_ref.sample_rate() as f64;
        let mut consumer = input_ref.take_consumer()
            .ok_or_else(|| napi::Error::from_reason("Failed to get consumer"))?;

        // DSP thread with silence suppression
        self.capture_thread = Some(thread::spawn(move || {
            let mut resampler = StreamingResampler::new(input_sample_rate, 16000.0);
            let mut frame_buffer: Vec<i16> = Vec::with_capacity(FRAME_SAMPLES * 4);
            let mut raw_batch: Vec<f32> = Vec::with_capacity(4096);
            
            let mut suppressor = SilenceSuppressor::new(
                SilenceSuppressionConfig::for_microphone()
            );

            // WebRTC VAD for voice vs noise discrimination (created in-thread because !Send)
            let mut webrtc_vad = Vad::new_with_rate_and_mode(
                VadSampleRate::Rate16kHz,
                VadMode::VeryAggressive,
            );

            // Track whether VAD confirmed any real voice since last silence period (Bug #1)
            let mut vad_confirmed_voice = false;

            println!("[MicrophoneCapture] DSP thread started (suppression active)");

            loop {
                if stop_signal.load(Ordering::Relaxed) {
                    break;
                }
                
                // 1. Drain ring buffer (lock-free)
                while let Some(sample) = consumer.try_pop() {
                    raw_batch.push(sample);
                    if raw_batch.len() >= 480 {
                        break;
                    }
                }
                
                // 2. Resample
                if !raw_batch.is_empty() {
                    let resampled = resampler.resample(&raw_batch);
                    frame_buffer.extend(resampled);
                    raw_batch.clear();
                }

                // 3. Process frames with Silence Suppression
                while frame_buffer.len() >= FRAME_SAMPLES {
                    let frame: Vec<i16> = frame_buffer.drain(0..FRAME_SAMPLES).collect();
                    let (action, speech_just_ended) = suppressor.process(&frame);
                    
                    match action {
                        FrameAction::Send(ref audio) => {
                            // Hangover frame detection (Bug #4)
                            let rms = audio.iter().map(|&s| (s as f64) * (s as f64)).sum::<f64>() / audio.len() as f64;
                            let is_hangover = rms.sqrt() < suppressor.adaptive_threshold() as f64;

                            if is_hangover {
                                tsfn.call(audio.clone(), ThreadsafeFunctionCallMode::NonBlocking);
                            } else {
                                let is_voice = webrtc_vad.is_voice_segment(audio).unwrap_or(true);
                                if is_voice {
                                    vad_confirmed_voice = true;
                                    tsfn.call(audio.clone(), ThreadsafeFunctionCallMode::NonBlocking);
                                } else {
                                    tsfn.call(generate_silence_frame(FRAME_SAMPLES), ThreadsafeFunctionCallMode::NonBlocking);
                                }
                            }
                        },
                        FrameAction::SendSilence => {
                             tsfn.call(generate_silence_frame(FRAME_SAMPLES), ThreadsafeFunctionCallMode::NonBlocking);
                        },
                        FrameAction::Suppress => {
                            // Do nothing
                        }
                    }

                    // Fire speech_ended ONLY if VAD confirmed real voice (Bug #1)
                    if speech_just_ended && vad_confirmed_voice {
                        if let Some(ref se_tsfn) = speech_ended_tsfn {
                            se_tsfn.call(true, ThreadsafeFunctionCallMode::NonBlocking);
                        }
                        vad_confirmed_voice = false;
                    } else if speech_just_ended {
                        vad_confirmed_voice = false;
                    }
                }
                
                // 4. Short sleep
                if frame_buffer.len() < FRAME_SAMPLES {
                    thread::sleep(Duration::from_millis(DSP_POLL_MS));
                }
            }
            
            println!("[MicrophoneCapture] DSP thread stopped.");
        }));

        Ok(())
    }

    #[napi]
    pub fn stop(&mut self) {
        self.stop_signal.store(true, Ordering::SeqCst);
        if let Some(handle) = self.capture_thread.take() {
            let _ = handle.join();
        }
        if let Some(input) = self.input.as_ref() {
            let _ = input.pause();
        }
    }
}

// ============================================================================
// DEVICE ENUMERATION
// ============================================================================

#[napi(object)]
pub struct AudioDeviceInfo {
    pub id: String,
    pub name: String,
}

#[napi]
pub fn get_input_devices() -> Vec<AudioDeviceInfo> {
    match microphone::list_input_devices() {
        Ok(devs) => devs.into_iter()
            .map(|(id, name)| AudioDeviceInfo { id, name })
            .collect(),
        Err(e) => {
            eprintln!("[get_input_devices] Error: {}", e);
            Vec::new()
        }
    }
}

#[napi]
pub fn get_output_devices() -> Vec<AudioDeviceInfo> {
    match speaker::list_output_devices() {
        Ok(devs) => devs.into_iter()
            .map(|(id, name)| AudioDeviceInfo { id, name })
            .collect(),
        Err(e) => {
            eprintln!("[get_output_devices] Error: {}", e);
            Vec::new()
        }
    }
}
