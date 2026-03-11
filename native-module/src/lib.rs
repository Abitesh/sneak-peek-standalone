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

pub mod vad; 
pub mod microphone;
pub mod speaker;
pub mod streaming_resampler;
pub mod audio_config;
pub mod silence_suppression;

// Keep old resampler module for compatibility
pub mod resampler;
pub mod license;

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
    tsfn_slot: Arc<std::sync::Mutex<Option<ThreadsafeFunction<Vec<i16>, ErrorStrategy::Fatal>>>>,
}

#[napi]
impl SystemAudioCapture {
    #[napi(constructor)]
    pub fn new(device_id: Option<String>) -> napi::Result<Self> {
        println!("[SystemAudioCapture] Created with eager init (device: {:?})", device_id);
        
        let stop_signal = Arc::new(AtomicBool::new(false));
        let tsfn_slot: Arc<std::sync::Mutex<Option<ThreadsafeFunction<Vec<i16>, ErrorStrategy::Fatal>>>> = Arc::new(std::sync::Mutex::new(None));
        
        let stop_signal_clone = stop_signal.clone();
        let device_id_clone = device_id.clone();
        let tsfn_slot_clone = tsfn_slot.clone();
        
        // DSP thread with ScreenCaptureKit init + silence suppression + Condvar wakeup
        let capture_thread = Some(thread::spawn(move || {
            println!("[SystemAudioCapture] Eagerly creating ScreenCaptureKit stream in background thread...");
            let input = match speaker::SpeakerInput::new(device_id_clone) {
                Ok(i) => i,
                Err(e) => {
                    println!("[SystemAudioCapture] Failed: {}. Trying default...", e);
                    match speaker::SpeakerInput::new(None) {
                        Ok(i) => i,
                        Err(e2) => {
                            eprintln!("[SystemAudioCapture] Final initialization failed: {}", e2);
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
                    eprintln!("[SystemAudioCapture] Failed to get consumer");
                    return;
                }
            };

            let mut resampler = StreamingResampler::new(input_sample_rate, 16000.0);
            let mut frame_buffer: Vec<i16> = Vec::with_capacity(FRAME_SAMPLES * 4);
            let mut raw_batch: Vec<f32> = Vec::with_capacity(4096);
            
            // Use system audio config (lower threshold for quieter system audio)
            let mut suppressor = SilenceSuppressor::new(
                SilenceSuppressionConfig::for_system_audio()
            );

            println!("[SystemAudioCapture] DSP thread started (suppression active)");

            loop {
                if stop_signal_clone.load(Ordering::Relaxed) {
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
                    match suppressor.process(&frame) {
                        FrameAction::Send(audio) => {
                            if let Ok(slot) = tsfn_slot_clone.lock() {
                                if let Some(tsfn) = slot.as_ref() {
                                    tsfn.call(audio, ThreadsafeFunctionCallMode::NonBlocking);
                                }
                            }
                        },
                        FrameAction::SendSilence => {
                            if let Ok(slot) = tsfn_slot_clone.lock() {
                                if let Some(tsfn) = slot.as_ref() {
                                    tsfn.call(generate_silence_frame(FRAME_SAMPLES), ThreadsafeFunctionCallMode::NonBlocking);
                                }
                            }
                        },
                        FrameAction::Suppress => {
                            // Do nothing (bandwidth saving)
                        }
                    }
                }
                
                // 4. Short sleep when buffer is starved
                if frame_buffer.len() < FRAME_SAMPLES {
                    thread::sleep(Duration::from_millis(DSP_POLL_MS));
                }
            }
            
            println!("[SystemAudioCapture] DSP thread stopped.");
        }));

        Ok(SystemAudioCapture {
            stop_signal,
            capture_thread,
            sample_rate: 16000,
            device_id,
            tsfn_slot,
        })
    }

    #[napi]
    pub fn get_sample_rate(&self) -> u32 {
        self.sample_rate
    }

    #[napi]
    pub fn start(&mut self, callback: JsFunction) -> napi::Result<()> {
        let tsfn: ThreadsafeFunction<Vec<i16>, ErrorStrategy::Fatal> = callback
            .create_threadsafe_function(0, |ctx| {
                let vec: Vec<i16> = ctx.value;
                let mut pcm_bytes = Vec::with_capacity(vec.len() * 2);
                for sample in vec {
                    pcm_bytes.extend_from_slice(&sample.to_le_bytes());
                }
                Ok(vec![pcm_bytes])
            })?;

        if let Ok(mut slot) = self.tsfn_slot.lock() {
            *slot = Some(tsfn);
        }

        Ok(())
    }

    #[napi]
    pub fn pause_capture(&mut self) {
        if let Ok(mut slot) = self.tsfn_slot.lock() {
            *slot = None;
        }
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
    pub fn start(&mut self, callback: JsFunction) -> napi::Result<()> {
        let tsfn: ThreadsafeFunction<Vec<i16>, ErrorStrategy::Fatal> = callback
            .create_threadsafe_function(0, |ctx| {
                let vec: Vec<i16> = ctx.value;
                let mut pcm_bytes = Vec::with_capacity(vec.len() * 2);
                for sample in vec {
                    pcm_bytes.extend_from_slice(&sample.to_le_bytes());
                }
                Ok(vec![pcm_bytes])
            })?;

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
            
            // Use microphone config (standard threshold)
            let mut suppressor = SilenceSuppressor::new(
                SilenceSuppressionConfig::for_microphone()
            );

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
                    match suppressor.process(&frame) {
                        FrameAction::Send(audio) => {
                             tsfn.call(audio, ThreadsafeFunctionCallMode::NonBlocking);
                        },
                        FrameAction::SendSilence => {
                             tsfn.call(generate_silence_frame(FRAME_SAMPLES), ThreadsafeFunctionCallMode::NonBlocking);
                        },
                         FrameAction::Suppress => {
                            // Do nothing
                        }
                    }
                }
                
                // 4. Short sleep when buffer is starved
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
