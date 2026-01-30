#![deny(clippy::all)]

#[macro_use]
extern crate napi_derive;

use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Env, JsFunction};
use ringbuf::traits::Consumer;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

pub mod speaker;
pub mod resampler; // Expose resampler

#[napi]
pub struct SystemAudioCapture {
    stop_signal: Arc<Mutex<bool>>,
    capture_thread: Option<thread::JoinHandle<()>>,
    sample_rate: u32,
    input: Option<speaker::SpeakerInput>,
    stream: Option<speaker::SpeakerStream>,
}

#[napi]
impl SystemAudioCapture {
    #[napi(constructor)]
    pub fn new(device_id: Option<String>) -> napi::Result<Self> {
        let input = match speaker::SpeakerInput::new(device_id) {
            Ok(i) => i,
            Err(e) => return Err(napi::Error::from_reason(format!("Failed to create speaker input: {}", e))),
        };
        let sample_rate = input.sample_rate() as u32;
        
        Ok(SystemAudioCapture {
            stop_signal: Arc::new(Mutex::new(false)),
            capture_thread: None,
            sample_rate,
            input: Some(input),
            stream: None,
        })
    }

    #[napi]
    pub fn get_sample_rate(&self) -> u32 {
        self.sample_rate
    }

    #[napi]
    pub fn start(&mut self, callback: JsFunction) -> napi::Result<()> {
        use crate::vad::VadGate;
        use crate::resampler::Resampler;

        let tsfn: ThreadsafeFunction<Vec<i16>, ErrorStrategy::Fatal> = callback
            .create_threadsafe_function(0, |ctx| {
                let vec: Vec<i16> = ctx.value;
                let mut pcm_bytes = Vec::with_capacity(vec.len() * 2);
                for sample in vec {
                    pcm_bytes.extend_from_slice(&sample.to_le_bytes());
                }
                Ok(vec![pcm_bytes])
            })?;

        *self.stop_signal.lock().unwrap() = false;
        let stop_signal = self.stop_signal.clone();
        
        let input = self.input.take().ok_or_else(|| napi::Error::from_reason("Capture already started or input missing"))?;
        
        // Create stream on main thread (NOT Send safe)
        let mut stream = input.stream();
        let input_sample_rate = stream.sample_rate() as f64;
        
        // Extract consumer (IS Send safe)
        let mut consumer = stream.take_consumer().ok_or_else(|| napi::Error::from_reason("Failed to get consumer"))?;
        
        self.stream = Some(stream);

        self.capture_thread = Some(thread::spawn(move || {
            // System Audio VAD: 20 chunks pre-roll (~2s)
            let mut vad = VadGate::new_with_config(20);
            // Resampler: Input Rate -> 16000
            let mut resampler = Resampler::new(input_sample_rate).expect("Failed to create resampler"); // TODO: Handle error better?

            loop {
                if *stop_signal.lock().unwrap() {
                    break;
                }
                
                let mut chunk = Vec::with_capacity(4800);
                for _ in 0..4800 {
                    if let Some(s) = consumer.try_pop() {
                        chunk.push(s);
                    } else {
                        break;
                    }
                }
                
                if !chunk.is_empty() {
                    // Resample f32 -> i16
                    if let Ok(resampled_chunk) = resampler.resample(&chunk) {
                        if !resampled_chunk.is_empty() {
                             // Pass through VAD
                             let speech_chunks = vad.process(resampled_chunk);
                             for speech in speech_chunks {
                                 if !speech.is_empty() {
                                     tsfn.call(speech, ThreadsafeFunctionCallMode::Blocking);
                                 }
                             }
                        }
                    }
                }
                
                thread::sleep(Duration::from_millis(10));
            }
        }));

        Ok(())
    }

    #[napi]
    pub fn stop(&mut self) {
        *self.stop_signal.lock().unwrap() = true;
        if let Some(handle) = self.capture_thread.take() {
            let _ = handle.join();
        }
        // Drop stream to stop capture
        self.stream = None;
    }
}

pub mod microphone;

#[napi]
pub struct MicrophoneCapture {
    stop_signal: Arc<Mutex<bool>>,
    capture_thread: Option<thread::JoinHandle<()>>,
    sample_rate: u32,
    input: Option<microphone::MicrophoneStream>,
}

#[napi]
#[napi]
impl MicrophoneCapture {
    #[napi(constructor)]
    pub fn new(device_id: Option<String>) -> napi::Result<Self> {
        let input = match microphone::MicrophoneStream::new(device_id) {
            Ok(i) => i,
            Err(e) => return Err(napi::Error::from_reason(format!("Failed to create microphone input: {}", e))),
        };
        let sample_rate = input.sample_rate();

        Ok(MicrophoneCapture {
            stop_signal: Arc::new(Mutex::new(false)),
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
        use crate::vad::VadGate; // Import VAD

        // Callback now receives Vec<i16> (s16le PCM samples)
        // We will output Buffer (byte array) to JS
        let tsfn: ThreadsafeFunction<Vec<i16>, ErrorStrategy::Fatal> = callback
            .create_threadsafe_function(0, |ctx| {
                let vec: Vec<i16> = ctx.value;
                let mut pcm_bytes = Vec::with_capacity(vec.len() * 2);
                for sample in vec {
                    pcm_bytes.extend_from_slice(&sample.to_le_bytes());
                }
                Ok(vec![pcm_bytes])
            })?;

        *self.stop_signal.lock().unwrap() = false;
        let stop_signal = self.stop_signal.clone();
        
        let input = self.input.as_mut().ok_or_else(|| napi::Error::from_reason("Capture already started or input missing"))?;
        
        // Play on main thread
        if let Err(e) = input.play() {
             return Err(napi::Error::from_reason(format!("Failed to start stream: {}", e)));
        }
        
        // Get consumer for thread
        let consumer = input.get_consumer();

        self.capture_thread = Some(thread::spawn(move || {
            let mut vad = VadGate::new(); // Initialize VAD
            
            loop {
                if *stop_signal.lock().unwrap() {
                    break;
                }
                
                let mut chunk = Vec::new();
                {
                    let mut cons = consumer.lock().unwrap();
                    // Consume available samples
                    // Chunk size target: ~100ms at 16kHz = 1600 samples
                    // The swift code used 0.1s buffer.
                    // Let's grab whatever is available up to a limit to avoid latency
                    while let Some(s) = cons.try_pop() {
                        chunk.push(s);
                        if chunk.len() >= 1600 { break; } // Process in ~100ms chunks for VAD
                    }
                }
                
                if !chunk.is_empty() {
                    // Pass through VAD
                    let speech_chunks = vad.process(chunk);
                    
                    for speech_chunk in speech_chunks {
                        if !speech_chunk.is_empty() {
                           tsfn.call(speech_chunk, ThreadsafeFunctionCallMode::Blocking);
                        }
                    }
                } else {
                    // Small sleep to prevent busy loop if buffer empty
                    thread::sleep(Duration::from_millis(5));
                }
            }
        }));

        Ok(())
    }

    #[napi]
    pub fn stop(&mut self) {
        *self.stop_signal.lock().unwrap() = true;
        if let Some(handle) = self.capture_thread.take() {
            let _ = handle.join();
        }
    }
}

#[napi(object)]
pub struct AudioDeviceInfo {
    pub id: String,
    pub name: String,
}

#[napi]
pub fn get_input_devices() -> Vec<AudioDeviceInfo> {
    match microphone::list_input_devices() {
        Ok(devs) => devs.into_iter().map(|(id, name)| AudioDeviceInfo { id, name }).collect(),
        Err(e) => {
            eprintln!("Failed to list input devices: {}", e);
            Vec::new()
        }
    }
}

#[napi]
pub fn get_output_devices() -> Vec<AudioDeviceInfo> {
    match speaker::list_output_devices() {
        Ok(devs) => devs.into_iter().map(|(id, name)| AudioDeviceInfo { id, name }).collect(),
        Err(e) => {
             eprintln!("Failed to list output devices: {}", e);
             Vec::new()
        }
    }
}
