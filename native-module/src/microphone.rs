use anyhow::Result;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use ringbuf::{traits::{Consumer, Producer, Split}, HeapRb, HeapProd, HeapCons};
use std::sync::{Arc, Mutex};

pub struct MicrophoneStream {
    stream: cpal::Stream,
    consumer: Arc<Mutex<HeapCons<f32>>>,
    sample_rate: u32,
}

pub fn list_input_devices() -> Result<Vec<(String, String)>> {
    let host = cpal::default_host();
    let devices = host.input_devices()?;
    let mut list = Vec::new();
    
    // Add Default option
    list.push(("default".to_string(), "Default Microphone".to_string()));

    for device in devices {
        if let Ok(name) = device.name() {
            // Use name as ID for simplicity in CPAL, or handle index if needed
            list.push((name.clone(), name));
        }
    }
    Ok(list)
}

impl MicrophoneStream {
    pub fn new(device_id: Option<String>) -> Result<Self> {
        let host = cpal::default_host();
        
        // Find input device or use default
        let device = if let Some(id) = device_id.filter(|s| s != "default") {
            host.input_devices()?
                .find(|d| d.name().map(|n| n == id).unwrap_or(false))
                .ok_or_else(|| anyhow::anyhow!("Microphone not found: {}", id))?
        } else {
            host.default_input_device()
                .ok_or_else(|| anyhow::anyhow!("No default microphone found"))?
        };

        let config = device.default_input_config()?;
        let sample_rate = config.sample_rate().0;
        let channels = config.channels() as usize;

        println!("[Microphone] Using device: {}", device.name().unwrap_or_default());
        println!("[Microphone] Sample Rate: {}, Channels: {}", sample_rate, channels);

        // Ring buffer (approx 0.5 sec buffer)
        let buffer_len = 48000; 
        let rb = HeapRb::<f32>::new(buffer_len);
        let (mut producer, consumer) = rb.split();
        
        let consumer = Arc::new(Mutex::new(consumer));
        
        let err_fn = |err| eprintln!("an error occurred on stream: {}", err);
        
        // Helpers to convert various formats to f32 and mix down to Mono if needed
        fn write_input_data_f32(input: &[f32], channels: usize, producer: &mut HeapProd<f32>) {
            for frame in input.chunks(channels) {
                let sample = frame[0]; // Take first channel (Left) for simplicity
                let _ = producer.try_push(sample);
            }
        }

        fn write_input_data_i16(input: &[i16], channels: usize, producer: &mut HeapProd<f32>) {
            for frame in input.chunks(channels) {
                let sample = frame[0].to_f32();
                let _ = producer.try_push(sample);
            }
        }

        fn write_input_data_u16(input: &[u16], channels: usize, producer: &mut HeapProd<f32>) {
            for frame in input.chunks(channels) {
                let sample = frame[0].to_f32();
                let _ = producer.try_push(sample);
            }
        }
        
        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => device.build_input_stream(
                &config.into(),
                move |data: &[f32], _: &_| write_input_data_f32(data, channels, &mut producer),
                err_fn,
                None
            )?,
            cpal::SampleFormat::I16 => device.build_input_stream(
                &config.into(),
                move |data: &[i16], _: &_| write_input_data_i16(data, channels, &mut producer),
                err_fn,
                None
            )?,
            cpal::SampleFormat::U16 => device.build_input_stream(
                &config.into(),
                move |data: &[u16], _: &_| write_input_data_u16(data, channels, &mut producer),
                err_fn,
                None
            )?,
            _ => return Err(anyhow::anyhow!("Unsupported sample format")),
        };

        // Note: We don't call play() here yet. We let the caller decide when to start.

        Ok(Self {
            stream,
            consumer,
            sample_rate
        })
    }

    pub fn play(&self) -> Result<()> {
        self.stream.play()?;
        Ok(())
    }

    pub fn pause(&self) -> Result<()> {
        self.stream.pause()?;
        Ok(())
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }
    
    pub fn get_consumer(&self) -> Arc<Mutex<HeapCons<f32>>> {
        self.consumer.clone()
    }
}

trait SampleToF32 {
    fn to_f32(&self) -> f32;
}

impl SampleToF32 for i16 {
    fn to_f32(&self) -> f32 {
        (*self as f32) / (i16::MAX as f32)
    }
}

impl SampleToF32 for u16 {
    fn to_f32(&self) -> f32 {
        ((*self as f32) - (u16::MAX as f32 / 2.0)) / (u16::MAX as f32 / 2.0)
    }
}
