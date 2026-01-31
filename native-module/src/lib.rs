#![deny(clippy::all)]

#[macro_use]
extern crate napi_derive;

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode, ErrorStrategy};
use ringbuf::traits::Consumer;

pub mod vad; 
pub mod microphone;
pub mod speaker;
pub mod resampler; 
pub mod audio_config;

#[napi]
pub struct SystemAudioCapture {
    stop_signal: Arc<Mutex<bool>>,
    capture_thread: Option<thread::JoinHandle<()>>,
    sample_rate: u32,
    device_id: Option<String>,  // Store for lazy init
    input: Option<speaker::SpeakerInput>,
    stream: Option<speaker::SpeakerStream>,
}

#[napi]
impl SystemAudioCapture {
    #[napi(constructor)]
    pub fn new(device_id: Option<String>) -> napi::Result<Self> {
        // LAZY INIT: Don't create SpeakerInput here - it creates CoreAudio tap
        // and causes 1-second audio mute + quality degradation at app launch
        println!("[SystemAudioCapture] Created with lazy init (device: {:?})", device_id);
        
        Ok(SystemAudioCapture {
            stop_signal: Arc::new(Mutex::new(false)),
            capture_thread: None,
            sample_rate: 16000, // Fixed output rate from Resampler
            device_id,
            input: None,  // Will be created in start()
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
        use crate::audio_config::CHUNK_SAMPLES;

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
        
        // LAZY INIT: Create SpeakerInput NOW (when meeting starts), not at app launch
        // This is where the CoreAudio tap gets created - the 1-second mute happens here
        // but only when the user actually starts a meeting, not when the app launches
        let input: speaker::SpeakerInput = if let Some(existing) = self.input.take() {
            existing
        } else {
            println!("[SystemAudioCapture] Creating audio tap now (lazy init)...");
            match speaker::SpeakerInput::new(self.device_id.take()) {
                Ok(i) => i,
                Err(e) => {
                     println!("[SystemAudioCapture] Failed to create input with device ID ({}). Falling back to default.", e);
                     // Fallback to default
                     match speaker::SpeakerInput::new(None) {
                         Ok(i) => i,
                         Err(e2) => return Err(napi::Error::from_reason(format!("Failed to create speaker input (default): {}", e2))),
                     }
                }
            }
        };
        
        let mut stream = input.stream();
        let input_sample_rate = stream.sample_rate() as f64;
        let mut consumer = stream.take_consumer().ok_or_else(|| napi::Error::from_reason("Failed to get consumer"))?;
        
        self.stream = Some(stream);

        self.capture_thread = Some(thread::spawn(move || { // AUDIO THREAD
            let mut vad = VadGate::new();
            let mut resampler = Resampler::new(input_sample_rate).expect("Failed to create resampler"); 
            
            // Accumulators
            let mut raw_batch = Vec::with_capacity(4096);
            let mut i16_accumulator: Vec<i16> = Vec::with_capacity(CHUNK_SAMPLES * 4); // ample headroom

            loop {
                if *stop_signal.lock().unwrap() {
                    break;
                }
                
                // 1. Drain raw audio from RingBuffer (Non-blocking)
                {
                    // No lock needed since we own the consumer in this thread
                    while let Some(s) = consumer.try_pop() {
                        raw_batch.push(s);
                        if raw_batch.len() >= 4800 { break; } 
                    }
                }
                
                // 2. Resample if we have data
                if !raw_batch.is_empty() {
                    if let Ok(resampled) = resampler.resample(&raw_batch) {
                        i16_accumulator.extend(resampled);
                    }
                    raw_batch.clear();
                }

                // 3. Emit detailed 1600-sample chunks
                while i16_accumulator.len() >= CHUNK_SAMPLES {
                    let chunk: Vec<i16> = i16_accumulator.drain(0..CHUNK_SAMPLES).collect();
                    
                    // VAD
                    let speech_chunks = vad.process(chunk);
                    for speech in speech_chunks {
                        if !speech.is_empty() {
                            // NonBlocking call to JS
                            println!("[SystemAudioCapture] Sending chunk: {} bytes", speech.len());
                            tsfn.call(speech, ThreadsafeFunctionCallMode::NonBlocking);
                        }
                    }
                }

                // 4. Yield/Sleep strategies
                // If we didn't have enough data to fill a chunk, we yield to avoid busy loop
                // "No guessed sleeps" -> but we must not consume 100% CPU.
                // 1ms sleep is acceptable if we are waiting for hardware.
                // Or yield_now().
                if i16_accumulator.len() < CHUNK_SAMPLES {
                     thread::sleep(Duration::from_millis(1));
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
        // Drop stream to stop capture
        self.stream = None; 
    }
}


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
        // We will resample to 16000
        let sample_rate = 16000;

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
        use crate::vad::VadGate; 
        use crate::resampler::Resampler;
        use crate::audio_config::CHUNK_SAMPLES;

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
        
        let input_ref = self.input.as_mut().ok_or_else(|| napi::Error::from_reason("Capture already started or input missing"))?;
        
        // Play on main thread
        if let Err(e) = input_ref.play() {
             return Err(napi::Error::from_reason(format!("Failed to start stream: {}", e)));
        }
        
        let input_sample_rate = input_ref.sample_rate() as f64;
        // Get consumer for thread
        let consumer = input_ref.get_consumer();

        self.capture_thread = Some(thread::spawn(move || { 
            let mut vad = VadGate::new(); 
            // Initialize Resampler with actual input rate
            let mut resampler = Resampler::new(input_sample_rate).expect("Failed to create resampler for mic");

            let mut raw_batch = Vec::with_capacity(4096);
            let mut i16_accumulator: Vec<i16> = Vec::with_capacity(CHUNK_SAMPLES * 4);

            loop {
                if *stop_signal.lock().unwrap() {
                    break;
                }
                
                // 1. Drain RingBuffer (f32)
                {
                    let mut cons = consumer.lock().unwrap();
                    while let Some(s) = cons.try_pop() {
                        raw_batch.push(s);
                        if raw_batch.len() >= 4800 { break; }
                    }
                }
                
                // 2. Resample (f32 -> i16 at 16k)
                if !raw_batch.is_empty() {
                    if let Ok(resampled) = resampler.resample(&raw_batch) {
                        i16_accumulator.extend(resampled);
                    }
                    raw_batch.clear();
                }

                // 3. Emit Chunks
                while i16_accumulator.len() >= CHUNK_SAMPLES {
                    let chunk: Vec<i16> = i16_accumulator.drain(0..CHUNK_SAMPLES).collect();
                    
                    let speech_chunks = vad.process(chunk);
                    for speech_chunk in speech_chunks {
                        if !speech_chunk.is_empty() {
                           println!("[MicrophoneCapture] Sending chunk: {} bytes", speech_chunk.len());
                           tsfn.call(speech_chunk, ThreadsafeFunctionCallMode::NonBlocking);
                        }
                    }
                }
                
                // 4. Yield
                if i16_accumulator.len() < CHUNK_SAMPLES {
                    thread::sleep(Duration::from_millis(1));
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
        // Optional: pause input?
        if let Some(input) = self.input.as_mut() {
            let _ = input.pause();
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
        Ok(devs) => devs.into_iter().map(|(id, name)| AudioDeviceInfo { id, name }).collect::<Vec<_>>(),
        Err(e) => {
            eprintln!("Failed to list input devices: {}", e);
            Vec::new()
        }
    }
}

#[napi]
pub fn get_output_devices() -> Vec<AudioDeviceInfo> {
    match speaker::list_output_devices() {
        Ok(devs) => devs.into_iter().map(|(id, name)| AudioDeviceInfo { id, name }).collect::<Vec<_>>(),
        Err(e) => {
             eprintln!("Failed to list output devices: {}", e);
             Vec::new()
        }
    }
}
