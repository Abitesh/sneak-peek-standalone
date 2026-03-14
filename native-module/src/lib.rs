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
use std::fs::OpenOptions;
use std::io::Write;

pub mod audio_config;
pub mod vad; 
pub mod microphone;
pub mod speaker;
use crate::audio_config::{FRAME_SAMPLES, DSP_POLL_MS};

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
            let mut consumer = match stream.take_consumer() {
                Some(c) => c,
                None => {
                    eprintln!("[SystemAudioCapture] FATAL: Failed to get consumer");
                    return;
                }
            };
            
            let initial_sample_rate = stream.sample_rate();
            println!("[SystemAudioCapture] Background init complete. Initial Rate: {}Hz. DSP starting.", initial_sample_rate);

            // 2. DSP loop with raw audio scaling (no resampling)
            let mut frame_buffer: Vec<i16> = Vec::with_capacity(FRAME_SAMPLES * 4);
            let mut raw_batch: Vec<f32> = Vec::with_capacity(4096);

            loop {
                if stop_signal.load(Ordering::Relaxed) {
                    break;
                }

                // Drain ALL available samples from ring buffer (lock-free)
                while let Some(sample) = consumer.try_pop() {
                    raw_batch.push(sample);
                }
                
                // Convert f32 -> i16 at Native sample rate
                if !raw_batch.is_empty() {
                    for &f in &raw_batch {
                        let scaled = (f * 32767.0).clamp(-32768.0, 32767.0);
                        frame_buffer.push(scaled as i16);
                    }
                    raw_batch.clear();
                }

                // Send chunks of exactly 4000 samples (~83ms at 48kHz). Google STT recommends ~100ms chunks.
                let chunk_size = 4000;
                while frame_buffer.len() >= chunk_size {
                    let frame: Vec<i16> = frame_buffer.drain(0..chunk_size).collect();
                    
                    // DEBUG: Write to file
                    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open("/tmp/natively_stt_debug_rust.pcm") {
                        let mut bytes = Vec::with_capacity(frame.len() * 2);
                        for &sample in &frame {
                            bytes.extend_from_slice(&sample.to_le_bytes());
                        }
                        let _ = file.write_all(&bytes);
                    }

                    tsfn.call(frame, ThreadsafeFunctionCallMode::NonBlocking);
                }
                
                // Keep the sleep small so we quickly read the ring buffer
                thread::sleep(Duration::from_millis(DSP_POLL_MS));
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
        
        let _initial_sample_rate = input_ref.sample_rate();
        let mut consumer = input_ref.take_consumer()
            .ok_or_else(|| napi::Error::from_reason("Failed to get consumer"))?;

        // DSP thread with bypass
        self.capture_thread = Some(thread::spawn(move || {
            let mut frame_buffer: Vec<i16> = Vec::with_capacity(FRAME_SAMPLES * 4);
            let mut raw_batch: Vec<f32> = Vec::with_capacity(4096);

            println!("[MicrophoneCapture] DSP thread started (suppression disabled)");

            loop {
                if stop_signal.load(Ordering::Relaxed) {
                    break;
                }

                // 1. Drain ALL available samples from ring buffer (lock-free)
                while let Some(sample) = consumer.try_pop() {
                    raw_batch.push(sample);
                }
                
                // 2. Convert f32 -> i16 at Native sample rate
                if !raw_batch.is_empty() {
                    for &f in &raw_batch {
                        let scaled = (f * 32767.0).clamp(-32768.0, 32767.0);
                        frame_buffer.push(scaled as i16);
                    }
                    raw_batch.clear();
                }

                // 3. Send chunks of exactly 4000 samples (~83ms at 48kHz)
                let chunk_size = 4000;
                while frame_buffer.len() >= chunk_size {
                    let frame: Vec<i16> = frame_buffer.drain(0..chunk_size).collect();

                    tsfn.call(frame, ThreadsafeFunctionCallMode::NonBlocking);
                }
                
                // 4. Short sleep
                thread::sleep(Duration::from_millis(DSP_POLL_MS));
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
