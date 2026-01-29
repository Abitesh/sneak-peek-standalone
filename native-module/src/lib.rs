#![deny(clippy::all)]

#[macro_use]
extern crate napi_derive;

use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Env, JsFunction};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

pub mod speaker;

#[napi]
pub struct SystemAudioCapture {
    stop_signal: Arc<Mutex<bool>>,
    capture_thread: Option<thread::JoinHandle<()>>,
    // device_id: Option<String>, // No longer needed if we store input
    sample_rate: u32,
    input: Option<speaker::SpeakerInput>,
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
            // device_id,
        })
    }

    #[napi]
    pub fn get_sample_rate(&self) -> u32 {
        self.sample_rate
    }

    #[napi]
    pub fn start(&mut self, callback: JsFunction) -> napi::Result<()> {
        let tsfn: ThreadsafeFunction<Vec<f32>, ErrorStrategy::Fatal> = callback
            .create_threadsafe_function(0, |ctx| {
                let vec: Vec<f32> = ctx.value;
                let mut pcm_bytes = Vec::with_capacity(vec.len() * 2);
                for sample in vec {
                    let s = (sample * 32767.0f32).clamp(-32768.0, 32767.0) as i16;
                    pcm_bytes.extend_from_slice(&s.to_le_bytes());
                }
                Ok(vec![pcm_bytes])
            })?;

        *self.stop_signal.lock().unwrap() = false;
        let stop_signal = self.stop_signal.clone();
        
        let mut input = self.input.take().ok_or_else(|| napi::Error::from_reason("Capture already started or input missing"))?;

        self.capture_thread = Some(thread::spawn(move || {
            let mut stream = input.stream();
            
            loop {
                if *stop_signal.lock().unwrap() {
                    break;
                }
                
                let samples = stream.read_chunk(4800); 
                
                if !samples.is_empty() {
                    tsfn.call(samples, ThreadsafeFunctionCallMode::Blocking);
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
        let tsfn: ThreadsafeFunction<Vec<f32>, ErrorStrategy::Fatal> = callback
            .create_threadsafe_function(0, |ctx| {
                let vec: Vec<f32> = ctx.value;
                let mut pcm_bytes = Vec::with_capacity(vec.len() * 2);
                for sample in vec {
                    let s = (sample * 32767.0f32).clamp(-32768.0, 32767.0) as i16;
                    pcm_bytes.extend_from_slice(&s.to_le_bytes());
                }
                Ok(vec![pcm_bytes])
            })?;

        *self.stop_signal.lock().unwrap() = false;
        let stop_signal = self.stop_signal.clone();
        
        let input = self.input.take().ok_or_else(|| napi::Error::from_reason("Capture already started or input missing"))?;

        self.capture_thread = Some(thread::spawn(move || {
            // Start playing (moved from new)
            if let Err(e) = input.play() {
                eprintln!("Failed to start microphone stream: {}", e);
                return;
            }

            loop {
                if *stop_signal.lock().unwrap() {
                    break;
                }
                
                let samples = input.read_chunk();
                if !samples.is_empty() {
                    tsfn.call(samples, ThreadsafeFunctionCallMode::Blocking);
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
