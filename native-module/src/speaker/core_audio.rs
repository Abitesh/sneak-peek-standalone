use anyhow::Result;
use cidre::{arc, av, cat, cf, core_audio as ca, ns, os};
use ringbuf::{traits::{Producer, Split}, HeapProd, HeapRb, HeapCons};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Waker};
use ca::aggregate_device_keys as agg_keys;

struct WakerState {
    waker: Option<Waker>,
    has_data: bool,
}

struct Ctx {
    format: arc::R<av::AudioFormat>,
    producer: HeapProd<f32>,
    waker_state: Arc<Mutex<WakerState>>,
    current_sample_rate: Arc<AtomicU32>,
    consecutive_drops: Arc<AtomicU32>,
    should_terminate: Arc<AtomicBool>,
}

pub struct SpeakerInput {
    tap: ca::TapGuard, 
    agg_desc: arc::R<cf::DictionaryOf<cf::String, cf::Type>>,
}

impl SpeakerInput {
    pub fn new(_device_id: Option<String>) -> Result<Self> {
        // GLOBAL TAP: Captures ALL system audio regardless of which device is playing
        // Based on pluely reference implementation
        // The device_id is ignored - we use default output just for aggregate device setup
        
        println!("[CoreAudioTap] === Global Tap Setup ===");
        
        // Use default output device for aggregate device configuration
        // This doesn't limit what we capture - the global tap gets everything
        let output_device = ca::System::default_output_device()?;
        let output_uid = output_device.uid()?;
        let output_name = output_device.name().map(|n| n.to_string()).unwrap_or_else(|_| "Unknown".to_string());
        
        println!("[CoreAudioTap] Aggregate device base: '{}' ({})", output_name, output_uid);
        println!("[CoreAudioTap] NOTE: Global tap captures ALL system audio regardless of output device");

        // Sub-device for aggregate device
        let sub_device = cf::DictionaryOf::with_keys_values(
            &[ca::sub_device_keys::uid()],
            &[output_uid.as_type_ref()],
        );

        // Create MONO global tap
        // Mono avoids complexity of stereo downmix and planar/interleaved format issues
        let tap_desc = ca::TapDesc::with_mono_global_tap_excluding_processes(&ns::Array::new());
        let tap = tap_desc.create_process_tap()?;
        println!("[CoreAudioTap] MONO global tap created: {:?}", tap.uid());

        let sub_tap = cf::DictionaryOf::with_keys_values(
            &[ca::sub_device_keys::uid()],
            &[tap.uid().unwrap().as_type_ref()],
        );

        // Create aggregate device descriptor
        let agg_name = cf::String::from_str("NativelySystemAudioTap");
        let agg_uid = cf::Uuid::new().to_cf_string();

        let agg_desc = cf::DictionaryOf::with_keys_values(
            &[
                agg_keys::is_private(),
                agg_keys::is_stacked(),
                agg_keys::tap_auto_start(),
                agg_keys::name(),
                agg_keys::main_sub_device(),
                agg_keys::uid(),
                agg_keys::sub_device_list(),
                agg_keys::tap_list(),
            ],
            &[
                cf::Boolean::value_true().as_type_ref(),
                cf::Boolean::value_false(),
                cf::Boolean::value_true(),
                &agg_name,
                &output_uid,
                &agg_uid,
                &cf::ArrayOf::from_slice(&[sub_device.as_ref()]),
                &cf::ArrayOf::from_slice(&[sub_tap.as_ref()]),
            ],
        );
        
        println!("[CoreAudioTap] === Setup Complete ===");

        Ok(Self { tap, agg_desc })
    }

    fn start_device(
        &self,
        ctx: &mut Box<Ctx>,
    ) -> Result<ca::hardware::StartedDevice<ca::AggregateDevice>> {
        extern "C" fn proc(
            device: ca::Device,
            _now: &cat::AudioTimeStamp,
            input_data: &cat::AudioBufList<1>,
            _input_time: &cat::AudioTimeStamp,
            _output_data: &mut cat::AudioBufList<1>,
            _output_time: &cat::AudioTimeStamp,
            ctx: Option<&mut Ctx>,
        ) -> os::Status {
            let ctx = ctx.unwrap();

            // Update sample rate if needed
            ctx.current_sample_rate.store(
                device.actual_sample_rate().unwrap_or(ctx.format.absd().sample_rate) as u32,
                Ordering::Release
            );

            // Extract audio data (simplified, matching pluely exactly)
            if let Some(view) = av::AudioPcmBuf::with_buf_list_no_copy(&ctx.format, input_data, None) {
                // For mono global tap, just get channel 0 and process
                if let Some(data) = view.data_f32_at(0) {
                    process_audio_data(ctx, data);
                }
            } else if ctx.format.common_format() == av::audio::CommonFormat::PcmF32 {
                // Fallback: raw buffer access
                let first_buffer = &input_data.buffers[0];
                let byte_count = first_buffer.data_bytes_size as usize;
                let float_count = byte_count / std::mem::size_of::<f32>();
                if float_count > 0 && !first_buffer.data.is_null() {
                     let data = unsafe {
                         std::slice::from_raw_parts(first_buffer.data as *const f32, float_count)
                     };
                     process_audio_data(ctx, data);
                }
            }

            os::Status::NO_ERR
        }

        let agg_device = ca::AggregateDevice::with_desc(&self.agg_desc)?;
        let proc_id = agg_device.create_io_proc_id(proc, Some(ctx))?;
        let started_device = ca::device_start(agg_device, Some(proc_id))?;
        println!("[CoreAudioTap] Aggregate device started successfully");

        Ok(started_device)
    }

    pub fn stream(self) -> SpeakerStream {
         let asbd = self.tap.asbd().unwrap_or_else(|_| {
             // Fallback to 44.1k f32 if tap returns nothing
             let mut asbd = cat::AudioStreamBasicDesc::default();
             asbd.sample_rate = 44100.0;
             asbd.format = cat::AudioFormat(0x6c70636d); // kAudioFormatLinearPCM
             asbd.format_flags = cat::AudioFormatFlags(1 | 8);   // kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked
             asbd.bytes_per_packet = 4;
             asbd.frames_per_packet = 1;
             asbd.bytes_per_frame = 4;
             asbd.channels_per_frame = 1;
             asbd.bits_per_channel = 32;
             asbd
        });
        
        let format = av::AudioFormat::with_asbd(&asbd).unwrap();
        println!("[CoreAudioTap] Format: {}Hz, {}ch", asbd.sample_rate, asbd.channels_per_frame);

        let buffer_size = 1024 * 128; // ~340ms at 48k
        let rb = HeapRb::<f32>::new(buffer_size);
        let (producer, consumer) = rb.split();

        let waker_state = Arc::new(Mutex::new(WakerState {
            waker: None,
            has_data: false,
        }));

        let current_sample_rate = Arc::new(AtomicU32::new(asbd.sample_rate as u32));

        let mut ctx = Box::new(Ctx {
            format,
            producer,
            waker_state: waker_state.clone(),
            current_sample_rate: current_sample_rate.clone(),
            consecutive_drops: Arc::new(AtomicU32::new(0)),
            should_terminate: Arc::new(AtomicBool::new(false)),
        });

        // Start!
        let device = self.start_device(&mut ctx).expect("Failed to start CoreAudio tap");

        SpeakerStream {
            consumer: Some(consumer),
            _device: device,
            _ctx: ctx,
            _tap: self.tap,
            current_sample_rate,
        }
    }
}

fn process_audio_data(ctx: &mut Ctx, data: &[f32]) {
    // Debug Logging for signal analysis
    static mut LOG_COUNTER: usize = 0;
    unsafe {
        LOG_COUNTER += 1;
        if LOG_COUNTER % 100 == 0 { // Log every ~100th callback (approx every 1-2 sec)
            let mut min = 0.0;
            let mut max = 0.0;
            let mut sum_sq = 0.0;
            for &s in data {
                if s < min { min = s; }
                if s > max { max = s; }
                sum_sq += s * s;
            }
            let rms = (sum_sq / data.len() as f32).sqrt();
            println!("[CoreAudioTap] Chunk: {} samples, Min: {:.4}, Max: {:.4}, RMS: {:.4}", data.len(), min, max, rms);
        }
    }

    let _pushed = ctx.producer.push_slice(data);
    
    // We can add overflow detection here later if needed
    // For now, lock-free push is all we need
    // Note: No mutexes here!
}

pub struct SpeakerStream {
    consumer: Option<HeapCons<f32>>, // Option so we can take it
    _device: ca::hardware::StartedDevice<ca::AggregateDevice>,
    _ctx: Box<Ctx>,
    _tap: ca::TapGuard,
    current_sample_rate: Arc<AtomicU32>,
}

impl SpeakerStream {
    pub fn sample_rate(&self) -> u32 {
        self.current_sample_rate.load(Ordering::Acquire)
    }

    pub fn take_consumer(&mut self) -> Option<HeapCons<f32>> {
        self.consumer.take()
    }
}


