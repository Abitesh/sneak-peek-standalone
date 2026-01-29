// Ported from Pluely
use anyhow::Result;
use cidre::{arc, av, cat, cf, core_audio as ca, ns, os};
use ringbuf::{
    traits::{Consumer, Producer, Split},
    HeapCons, HeapProd, HeapRb,
};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Poll, Waker};

// Helper to find aggregate device keys since `ca::aggregate_device_keys` might not be directly exposed or slightly different
mod agg_keys {
    use cidre::cf;
    
    pub fn is_private() -> &'static cf::String {
        cf::str!(c"private")
    }
    pub fn is_stacked() -> &'static cf::String {
        cf::str!(c"stacked")
    }
    pub fn tap_auto_start() -> &'static cf::String {
        cf::str!(c"tapautostart")
    }
    pub fn name() -> &'static cf::String {
        cf::str!(c"name")
    }
    pub fn main_sub_device() -> &'static cf::String {
        cf::str!(c"master")
    }
    pub fn uid() -> &'static cf::String {
         cf::str!(c"uid")
    }
    pub fn sub_device_list() -> &'static cf::String {
         cf::str!(c"subdevices")
    }
    pub fn tap_list() -> &'static cf::String {
         cf::str!(c"taps")
    }
}

fn find_output_device_by_uid(uid: &str) -> Option<ca::Device> {
    let all_devices = match ca::System::devices() {
        Ok(d) => d,
        Err(e) => {
            eprintln!(
                "[find_output_device_by_uid] Failed to get system devices: {}",
                e
            );
            return None;
        }
    };

    for device in all_devices.into_iter() {
        if let Ok(cfg) = device.output_stream_cfg() {
            if cfg.number_buffers() > 0 {
                if let Ok(device_uid) = device.uid() {
                    if device_uid.to_string() == uid {
                        return Some(device);
                    }
                }
            }
        }
    }

    eprintln!(
        "[find_output_device_by_uid] No matching device found for UID: {}",
        uid
    );
    None
}

pub fn list_output_devices() -> Result<Vec<(String, String)>> {
    let all_devices = match ca::System::devices() {
        Ok(d) => d,
        Err(e) => return Err(anyhow::anyhow!("Failed to get devices: {}", e)),
    };

    let mut list = Vec::new();
    for device in all_devices.into_iter() {
        if let Ok(cfg) = device.output_stream_cfg() {
            if cfg.number_buffers() > 0 {
                let uid = device.uid().map(|u| u.to_string()).unwrap_or_default();
                let name = device.name().map(|n| n.to_string()).unwrap_or_default();
                if !uid.is_empty() {
                    list.push((uid, name));
                }
            }
        }
    }
    Ok(list)
}

pub struct SpeakerInput {
    tap: ca::TapGuard,
    agg_desc: arc::Retained<cf::DictionaryOf<cf::String, cf::Type>>,
}

struct WakerState {
    waker: Option<Waker>,
    has_data: bool,
}

pub struct SpeakerStream {
    consumer: Option<HeapCons<f32>>,
    _device: ca::hardware::StartedDevice<ca::AggregateDevice>,
    _ctx: Box<Ctx>,
    _tap: ca::TapGuard,
    waker_state: Arc<Mutex<WakerState>>,
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


struct Ctx {
    format: arc::R<av::AudioFormat>,
    producer: HeapProd<f32>,
    waker_state: Arc<Mutex<WakerState>>,
    current_sample_rate: Arc<AtomicU32>,
    consecutive_drops: Arc<AtomicU32>,
    should_terminate: Arc<AtomicBool>,
}

impl SpeakerInput {
    pub fn new(device_id: Option<String>) -> Result<Self> {
        let output_device = match device_id {
            Some(ref uid) if !uid.is_empty() && uid != "default" => {
                match find_output_device_by_uid(uid) {
                    Some(device) => device,
                    None => {
                        ca::System::default_output_device().expect("No default output device found")
                    }
                }
            }
            _ => ca::System::default_output_device()?,
        };

        let output_uid = output_device.uid()?;

        let sub_device = cf::DictionaryOf::with_keys_values(
            &[ca::sub_device_keys::uid()],
            &[output_uid.as_type_ref()],
        );

        let tap_desc = ca::TapDesc::with_mono_global_tap_excluding_processes(&ns::Array::new());
        let tap = tap_desc.create_process_tap()?;

        let sub_tap = cf::DictionaryOf::with_keys_values(
            &[ca::sub_device_keys::uid()],
            &[tap.uid().unwrap().as_type_ref()],
        );

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
                cf::str!(c"system-audio-tap"), // Simplified name
                &output_uid,
                &cf::Uuid::new().to_cf_string(),
                &cf::ArrayOf::from_slice(&[sub_device.as_ref()]),
                &cf::ArrayOf::from_slice(&[sub_tap.as_ref()]),
            ],
        );

        Ok(Self { tap, agg_desc })
    }

    pub fn sample_rate(&self) -> f64 {
        self.tap.asbd().map(|d| d.sample_rate).unwrap_or(48000.0)
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

            ctx.current_sample_rate.store(
                device
                    .actual_sample_rate()
                    .unwrap_or(ctx.format.absd().sample_rate) as u32,
                Ordering::Release,
            );

            if let Some(view) =
                av::AudioPcmBuf::with_buf_list_no_copy(&ctx.format, input_data, None)
            {
                if let Some(data) = view.data_f32_at(0) {
                    process_audio_data(ctx, data);
                }
            } else if ctx.format.common_format() == av::audio::CommonFormat::PcmF32 {
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

        Ok(started_device)
    }

    pub fn stream(self) -> SpeakerStream {
        let asbd = self.tap.asbd().unwrap();
        let format = av::AudioFormat::with_asbd(&asbd).unwrap();

        let buffer_size = 1024 * 128; // 128K samples
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

        let device = self.start_device(&mut ctx).expect("Failed to start device");

        SpeakerStream {
            consumer: Some(consumer),
            _device: device,
            _ctx: ctx,
            _tap: self.tap,
            waker_state,
            current_sample_rate,
        }
    }
}

fn process_audio_data(ctx: &mut Ctx, data: &[f32]) {
    let buffer_size = data.len();
    let pushed = ctx.producer.push_slice(data);

    // Consistent buffer overflow handling
    if pushed < buffer_size {
        let consecutive = ctx.consecutive_drops.fetch_add(1, Ordering::AcqRel) + 1;

        // Only terminate after many consecutive drops (prevents temporary spikes from killing stream)
        if consecutive == 25 {
            eprintln!("Warning: Audio buffer experiencing drops - system may be overloaded");
        }

        if consecutive > 50 {
            eprintln!("Critical: Audio buffer overflow - capture stopping");
            ctx.should_terminate.store(true, Ordering::Release);
            return;
        }
    } else {
        // Success - reset consecutive drops counter
        ctx.consecutive_drops.store(0, Ordering::Release);
    }

    // Since we are not doing async waker logic for NAPI (we pull data), we might not strictly need to wake a task.
    // But sticking to the structure is fine.
    let _should_wake = {
        let mut waker_state = ctx.waker_state.lock().unwrap();
        if !waker_state.has_data {
            waker_state.has_data = true;
            waker_state.waker.take()
        } else {
            None
        }
    };
    // if let Some(waker) = should_wake { waker.wake(); }
}
