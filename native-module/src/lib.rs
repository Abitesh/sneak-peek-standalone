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
    input: Option<speaker::SpeakerInput>,
    stream: Option<speaker::SpeakerStream>,
}

#[napi]
impl SystemAudioCapture {
    #[napi(constructor)]
    pub fn new(device_id: Option<String>) -> napi::Result<Self> {
        println!("[SystemAudioCapture] Created with lazy init (device: {:?})", device_id);
        
        Ok(SystemAudioCapture {
            stop_signal: Arc::new(AtomicBool::new(false)),
            capture_thread: None,
            sample_rate: 16000,
            device_id,
            input: None,
            stream: None,
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
        
        // Lazy init: Create SpeakerInput now
        let input = if let Some(existing) = self.input.take() {
            existing
        } else {
            println!("[SystemAudioCapture] Creating ScreenCaptureKit stream...");
            match speaker::SpeakerInput::new(self.device_id.take()) {
                Ok(i) => i,
                Err(e) => {
                    println!("[SystemAudioCapture] Failed: {}. Trying default...", e);
                    match speaker::SpeakerInput::new(None) {
                        Ok(i) => i,
                        Err(e2) => return Err(napi::Error::from_reason(format!("Failed: {}", e2))),
                    }
                }
            }
        };
        
        let mut stream = input.stream();
        let input_sample_rate = stream.sample_rate() as f64;
        let mut consumer = stream.take_consumer()
            .ok_or_else(|| napi::Error::from_reason("Failed to get consumer"))?;
        
        self.stream = Some(stream);

        // DSP thread with silence suppression and AGC
        self.capture_thread = Some(thread::spawn(move || {
            let mut resampler = StreamingResampler::new(input_sample_rate, 16000.0);
            let mut frame_buffer: Vec<i16> = Vec::with_capacity(FRAME_SAMPLES * 4);
            let mut raw_batch: Vec<f32> = Vec::with_capacity(4096);
            
            // Use system audio config (lower threshold for quieter system audio)
            let mut suppressor = SilenceSuppressor::new(
                SilenceSuppressionConfig::for_system_audio()
            );
            
            // Automatic Gain Control for system audio
            let target_rms: f32 = 0.1; // Target RMS level (10% of full scale)
            let max_gain: f32 = 50.0;  // Maximum amplification (50x = ~34dB boost)
            let mut current_gain: f32 = 10.0; // Start with 10x gain
            let gain_smoothing: f32 = 0.95; // Smooth gain changes
            let mut agc_update_counter = 0u32;

            println!("[SystemAudioCapture] DSP thread started (AGC + suppression active)");

            loop {
                if stop_signal.load(Ordering::Relaxed) {
                    break;
                }
                
                // 1. Drain ring buffer (lock-free)
                let mut _batch_count = 0;
                while let Some(sample) = consumer.try_pop() {
                    raw_batch.push(sample);
                    _batch_count += 1;
                    if raw_batch.len() >= 480 {
                        break;
                    }
                }
                
                // 2. Apply AGC to raw batch BEFORE resampling
                // 2. AGC DISABLED FOR DEBUGGING
                /*
                if !raw_batch.is_empty() {
                    // Calculate RMS of current batch
                    let sum_squares: f32 = raw_batch.iter()
                        .step_by(4)
                        .map(|&s| s * s)
                        .sum();
                    let batch_rms = (sum_squares / (raw_batch.len() / 4) as f32).sqrt();
                    
                    // Update gain adaptively (but not too aggressively)
                    if batch_rms > 0.001 { // Only adjust if there's actual signal
                        let desired_gain = target_rms / batch_rms;
                        let target_gain = desired_gain.clamp(1.0, max_gain);
                        current_gain = gain_smoothing * current_gain + (1.0 - gain_smoothing) * target_gain;
                    }
                    
                    // Apply gain with soft clipping
                    for sample in raw_batch.iter_mut() {
                        let amplified = *sample * current_gain;
                        // Soft clip to prevent harsh distortion
                        *sample = if amplified.abs() > 0.9 {
                            amplified.signum() * (0.9 + 0.1 * (1.0 - (-10.0 * (amplified.abs() - 0.9)).exp()))
                        } else {
                            amplified
                        };
                    }
                    
                    // Debug logging
                    agc_update_counter += 1;
                    if agc_update_counter % 100 == 0 {
                        println!("[SystemAudioCapture-AGC] RMS: {:.4} -> Gain: {:.1}x", batch_rms, current_gain);
                    }
                }
                */
                
                // 3. Resample
                if !raw_batch.is_empty() {
                    let resampled = resampler.resample(&raw_batch);
                    frame_buffer.extend(resampled);
                    raw_batch.clear();
                }

                // 3. Process frames (SUPPRESSION DISABLED FOR DEBUGGING)
                while frame_buffer.len() >= FRAME_SAMPLES {
                    let frame: Vec<i16> = frame_buffer.drain(0..FRAME_SAMPLES).collect();
                    // Just send everything directly
                    tsfn.call(frame, ThreadsafeFunctionCallMode::NonBlocking);
                    /*
                    match suppressor.process(&frame) {
                        FrameAction::Send(audio) => {
                             tsfn.call(audio, ThreadsafeFunctionCallMode::NonBlocking);
                        },
                        FrameAction::SendSilence => {
                             tsfn.call(generate_silence_frame(FRAME_SAMPLES), ThreadsafeFunctionCallMode::NonBlocking);
                        },
                        FrameAction::Suppress => {
                            // Do nothing (bandwidth saving)
                        }
                    }
                    */
                }
                
                // 4. Short sleep
                if frame_buffer.len() < FRAME_SAMPLES {
                    thread::sleep(Duration::from_millis(DSP_POLL_MS));
                }
            }
            
            println!("[SystemAudioCapture] DSP thread stopped.");
        }));

        Ok(())
    }

    #[napi]
    pub fn stop(&mut self) {
        self.stop_signal.store(true, Ordering::SeqCst);
        if let Some(handle) = self.capture_thread.take() {
            let _ = handle.join();
        }
        self.stream = None;
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
                let mut batch_count = 0;
                while let Some(sample) = consumer.try_pop() {
                    raw_batch.push(sample);
                    batch_count += 1;
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
