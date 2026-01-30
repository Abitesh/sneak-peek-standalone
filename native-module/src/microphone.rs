use anyhow::Result;
use cidre::{arc, av, core_audio, cf, dispatch, ns};
use cidre::core_audio::Object; // Add this trait import
use ringbuf::{traits::{Consumer, Producer, Split}, HeapRb, HeapProd, HeapCons};
use std::sync::{Arc, Mutex};
// Reuse the existing robust Resampler
use crate::resampler::Resampler;

pub struct MicrophoneStream {
    engine: arc::R<av::AudioEngine>,
    consumer: Arc<Mutex<HeapCons<i16>>>, // Now yields i16 directly (16kHz)
    sample_rate: u32,
    _queue: arc::R<dispatch::Queue>, // Keep queue alive
}

pub fn list_input_devices() -> Result<Vec<(String, String)>> {
    // Use explicit core_audio
    let devices = core_audio::System::devices()?;
    let mut list = Vec::new();
    list.push(("default".to_string(), "Default Microphone".to_string()));

    for device in devices {
        // Check if device supports input
        if let Ok(cfg) = device.input_stream_cfg() {
             if cfg.number_buffers() > 0 {
                 // Fix closure signature: map receives Retained<String> (R<String>)
                 let uid = device.uid().map(|u: cidre::arc::R<cidre::cf::String>| u.to_string()).unwrap_or_default();
                 let name = device.name().map(|n: cidre::arc::R<cidre::cf::String>| n.to_string()).unwrap_or_default();
                 if !uid.is_empty() {
                     list.push((uid, name));
                 }
             }
        }
    }
    Ok(list)
}

impl MicrophoneStream {
    pub fn new(_device_id: Option<String>) -> Result<Self> {
        let mut engine = av::AudioEngine::new();
        let mut input_node = engine.input_node();
        
        // --- DEVICE SELECTION LOGIC ---
        if let Some(req_id) = _device_id.as_ref() {
             if req_id != "default" {
                 let devices = core_audio::System::devices()?;
                 let mut found_device_id: Option<u32> = None;
                 
                 for dev in devices {
                     let uid = dev.uid().map(|u| u.to_string()).unwrap_or_default();
                     if &uid == req_id {
                          found_device_id = Some(dev.id());
                          println!("[Microphone] Found requested device: {} (ID: {})", uid, dev.id());
                          break;
                     }
                 }
                 
                if let Some(dev_id) = found_device_id {
                     // AudioUnit is Retained, not Option
                     let mut au = input_node.audio_unit();
                     // kAudioOutputUnitProperty_CurrentDevice = 2000
                     // Scope Global = 0
                     match au.set_prop(2000, 0, 0, &dev_id) {
                         Ok(_) => println!("[Microphone] Successfully switched Input Node to device ID {}", dev_id),
                         Err(e) => println!("[Microphone] Failed to set device: {:?}", e),
                     }
                } else {
                     println!("[Microphone] Requested device {} not found, using default", req_id);
                }
             }
        }
        // -----------------------------

        println!("[Microphone] Using input node configuration");

        // Get hardware format
        let input_format = input_node.output_format_for_bus(0);
        
        // Dynamically retrieve sample rate to prevent pitch shift
        // Workaround: Parse debug string since direct access methods are failing
        let format_str = format!("{:?}", input_format);
        let mut parsed_rate = 48000.0;
        
        // Search for "sample_rate" or "mSampleRate" in the format description
        // Example: "... sample_rate: 44100.0 ..."
        if let Some(pos) = format_str.find("sample_rate: ") {
            if let Some(slice) = format_str.get(pos + 13..) {
                if let Some(end) = slice.find(',') {
                     if let Ok(rate) = slice[..end].trim().parse::<f64>() {
                         parsed_rate = rate;
                     }
                }
            }
        } 
        
        // Fallback or override
        let sample_rate = if parsed_rate < 100.0 {
            println!("[Microphone] Warning: Parsed sample rate {} looks invalid. using 48000.0. Debug: {}", parsed_rate, format_str);
            48000.0 
        } else {
            parsed_rate
        };
        
        println!("[Microphone] Detected Input Format: {} Hz (Parsed), {} ch", 
            sample_rate, 
            input_format.channel_count()
        );

        // Prepare Ring Buffer for 16kHz Int16 Output
        // 16000 * 2 (seconds) buffer
        let buffer_len = 32000; 
        let rb = HeapRb::<i16>::new(buffer_len);
        let (producer, consumer) = rb.split();
        let producer = Arc::new(Mutex::new(producer));
        
        // Initialize Resampler
        // If sample_rate is 0 (unlikely), error out or default
        let use_rate = if sample_rate < 100.0 { 48000.0 } else { sample_rate };
        let resampler = Resampler::new(use_rate).map_err(|e| anyhow::anyhow!(e))?;
        let resampler = Arc::new(Mutex::new(resampler));
        
        // Install Tap
        // Swift: bufferSize = inputRate * 0.1 (100ms)
        let buffer_size = (use_rate * 0.1) as u32; // 100ms
        
        // Logic for tap block
        let producer_clone = producer.clone();
        let resampler_clone = resampler.clone();
        
        let block = move |buffer: &av::AudioPcmBuf, _time: &av::AudioTime| {
            let mut producer = producer_clone.lock().unwrap();
            let mut resampler = resampler_clone.lock().unwrap();
            
            // Extract f32 data from buffer
            if let Some(data) = buffer.data_f32_at(0) {
                 // Resample to 16kHz Int16
                 if let Ok(output) = resampler.resample(data) {
                     // Push to ringbuffer
                     let _ = producer.push_slice(&output);
                 }
            }
        };

        // Install tap on bus 0
        input_node.install_tap_on_bus(0, buffer_size, Some(&input_format), block);

        // Prepare engine
        engine.prepare();
        println!("[Microphone] Engine Prepared");

        let queue = dispatch::Queue::new();

        Ok(Self {
            engine,
            consumer: Arc::new(Mutex::new(consumer)),
            sample_rate: 16000, // Fixed output rate
            _queue: queue,
        })
    }

    pub fn play(&mut self) -> Result<()> {
        self.engine.start()?;
        println!("[Microphone] Engine Started");
        Ok(())
    }

    pub fn pause(&mut self) -> Result<()> {
        self.engine.pause();
        Ok(())
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }
    
    pub fn get_consumer(&self) -> Arc<Mutex<HeapCons<i16>>> {
        self.consumer.clone()
    }
}
