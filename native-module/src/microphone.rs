use anyhow::Result;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use ringbuf::{traits::{Consumer, Producer, Split}, HeapRb, HeapProd, HeapCons};
use std::sync::{Arc, Mutex};
// use std::thread;

pub struct MicrophoneStream {
    stream: cpal::Stream,
    consumer: Arc<Mutex<HeapCons<f32>>>,
    sample_rate: u32,
}

pub fn list_input_devices() -> Result<Vec<(String, String)>> {
    let host = cpal::default_host();
    let devices = host.input_devices()?;
    let mut list = Vec::new();
    for device in devices {
        if let Ok(name) = device.name() {
            list.push((name.clone(), name));
        }
    }
    Ok(list)
}

impl MicrophoneStream {
    pub fn new(device_id: Option<String>) -> Result<Self> {
        let host = cpal::default_host();
        
        // Find input device
        let device = if let Some(id) = device_id {
            host.input_devices()?
                .find(|d| d.name().map(|n| n == id).unwrap_or(false))
                .ok_or_else(|| anyhow::anyhow!("Microphone not found"))?
        } else {
            host.default_input_device()
                .ok_or_else(|| anyhow::anyhow!("No default microphone found"))?
        };

        let config = device.default_input_config()?;
        let sample_rate = config.sample_rate().0;
        let channels = config.channels();

        println!("[Microphone] Using device: {}", device.name().unwrap_or_default());
        println!("[Microphone] Sample Rate: {}, Channels: {}", sample_rate, channels);

        // Ring buffer for audio data
        let buffer_len = 8192 * 4;
        let rb = HeapRb::<f32>::new(buffer_len);
        let (mut producer, consumer) = rb.split();
        
        let consumer = Arc::new(Mutex::new(consumer));
        
        let err_fn = |err| eprintln!("an error occurred on stream: {}", err);
        
        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => device.build_input_stream(
                &config.into(),
                move |data: &[f32], _: &_| write_input_data_f32(data, &mut producer),
                err_fn,
                None
            )?,
            cpal::SampleFormat::I16 => device.build_input_stream(
                &config.into(),
                move |data: &[i16], _: &_| write_input_data_i16(data, &mut producer),
                err_fn,
                None
            )?,
            cpal::SampleFormat::U16 => device.build_input_stream(
                &config.into(),
                move |data: &[u16], _: &_| write_input_data_u16(data, &mut producer),
                err_fn,
                None
            )?,
            _ => return Err(anyhow::anyhow!("Unsupported sample format")),
        };

        // stream.play()?; // Don't auto play

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

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn read_chunk(&self) -> Vec<f32> {
        let mut consumer = self.consumer.lock().unwrap();
        // In ringbuf 0.4, len() is on the ringbuffer or via traits. 
        // We can just iterate or try_pop until empty or max count.
        // But `consumer` is HeapCons which implies HeapRb?
        // Let's use `try_pop` in a loop.
        let mut chunk = Vec::new();
        // Read available samples
        while let Some(s) = consumer.try_pop() {
            chunk.push(s);
            if chunk.len() >= 4800 { break; } // limit chunk size to ~100ms at 48k
        }
        chunk
    }
}

fn write_input_data_f32(input: &[f32], producer: &mut HeapProd<f32>) {
    for &sample in input {
        let _ = producer.try_push(sample);
    }
}

fn write_input_data_i16(input: &[i16], producer: &mut HeapProd<f32>) {
    for &sample in input {
        let _ = producer.try_push(sample.to_f32() / i16::MAX as f32);
    }
}

fn write_input_data_u16(input: &[u16], producer: &mut HeapProd<f32>) {
    for &sample in input {
        let _ = producer.try_push((sample.to_f32() - u16::MAX as f32 / 2.0) / (u16::MAX as f32 / 2.0));
    }
}

trait SampleToF32 {
    fn to_f32(&self) -> f32;
}

impl SampleToF32 for i16 {
    fn to_f32(&self) -> f32 {
        *self as f32
    }
}

impl SampleToF32 for u16 {
    fn to_f32(&self) -> f32 {
        *self as f32
    }
}
