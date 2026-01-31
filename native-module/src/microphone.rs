use anyhow::Result;
use cidre::{arc, av, core_audio, dispatch};
use ringbuf::{traits::{Producer, Split}, HeapRb, HeapCons};
use std::sync::{Arc, Mutex};

pub struct MicrophoneStream {
    engine: arc::R<av::AudioEngine>,
    consumer: Arc<Mutex<HeapCons<f32>>>, // Changed to f32
    sample_rate: u32,
    _queue: arc::R<dispatch::Queue>, 
}

pub fn list_input_devices() -> Result<Vec<(String, String)>> {
    let devices = core_audio::System::devices()?;
    let mut list = Vec::new();
    list.push(("default".to_string(), "Default Microphone".to_string()));

    for device in devices {
        if let Ok(cfg) = device.input_stream_cfg() {
             if cfg.number_buffers() > 0 {
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
        
        // Disable VPIO on Input Node
        if let Ok(_) = input_node.set_vp_enabled(false) {
            println!("[Microphone] Input: Voice Processing (VPIO) disabled");
        }
        
        // Explicitly disable AGC and Bypass (Double safety)
        input_node.set_vp_agc_enabled(false);
        input_node.set_vp_bypassed(true);
        
        // REMOVED Output Node logic to prevent "Voice Chat" profile trigger
        // let mut output_node = engine.output_node(); ...
        
        // --- DEVICE SELECTION LOGIC (Simplified) ---
        if let Some(req_id) = _device_id.as_ref() {
             if req_id != "default" {
                 // Device selection placeholder
                 println!("[Microphone] Requested device {} (Selection pending implementation)", req_id);
             }
        }

        let input_format = input_node.output_format_for_bus(0);
        let format_str = format!("{:?}", input_format);
        let mut parsed_rate = 48000.0;
        
        if let Some(pos) = format_str.find("sample_rate: ") {
            if let Some(slice) = format_str.get(pos + 13..) {
                if let Some(end) = slice.find(',') {
                     if let Ok(rate) = slice[..end].trim().parse::<f64>() {
                         parsed_rate = rate;
                     }
                }
            }
        } 
        
        let sample_rate = if parsed_rate < 100.0 { 48000.0 } else { parsed_rate };
        println!("[Microphone] Detected Input Format: {} Hz, {} ch", sample_rate, input_format.channel_count());

        // Prepare Ring Buffer for F32 (Raw) Output
        let buffer_len = 48000 * 2; 
        let rb = HeapRb::<f32>::new(buffer_len);
        let (producer, consumer) = rb.split();
        let producer = Arc::new(Mutex::new(producer));
        
        // Install Tap - Copy raw F32
        let buffer_size = (sample_rate * 0.1) as u32; // 100ms
        let producer_clone = producer.clone();
        
        let block = move |buffer: &av::AudioPcmBuf, _time: &av::AudioTime| {
            println!("[Microphone] Tap callback executed");
            let mut producer = producer_clone.lock().unwrap();
            
            if let Some(data) = buffer.data_f32_at(0) {
                 // println!("[Microphone] Tap received {} samples", data.len());
                 let _ = producer.push_slice(data);
            } else {
                 println!("[Microphone] Buffer empty or format mismatch");
            }
        };

        input_node.install_tap_on_bus(0, buffer_size, Some(&input_format), block).expect("Failed to install tap");

        engine.prepare();
        println!("[Microphone] Engine Prepared");

        let queue = dispatch::Queue::new();

        Ok(Self {
            engine,
            consumer: Arc::new(Mutex::new(consumer)),
            sample_rate: sample_rate as u32,
            _queue: queue,
        })
    }

    pub fn play(&mut self) -> Result<()> {
        self.engine.start()?;
        println!("[Microphone] Engine Started");
        Ok(())
    }

    pub fn pause(&mut self) -> Result<()> {
        // use pause() for seamless toggle (keeps hardware active, instantaneous)
        self.engine.pause(); 
        Ok(())
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }
    
    pub fn get_consumer(&self) -> Arc<Mutex<HeapCons<f32>>> {
        self.consumer.clone()
    }
}
