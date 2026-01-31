// ScreenCaptureKit-based system audio capture
// Uses cidre 0.11.10 API with correct class registration and inner state

use anyhow::Result;
use cidre::{arc, sc, cm, dispatch, ns, objc, define_obj_type};
use cidre::sc::StreamOutput;
use ringbuf::{traits::{Producer, Split}, HeapProd, HeapRb, HeapCons};

// keep for compatibility
use cidre::core_audio as ca;

pub fn list_output_devices() -> Result<Vec<(String, String)>> {
    let all_devices = ca::System::devices()?;
    let mut list = Vec::new();
    for device in all_devices {
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

pub struct AudioHandlerInner {
    producer: HeapProd<f32>,
}

define_obj_type!(
    AudioHandler + sc::stream::OutputImpl,
    AudioHandlerInner,
    AUDIO_HANDLER_CLS
);

impl sc::stream::Output for AudioHandler {}

#[objc::add_methods]
impl sc::stream::OutputImpl for AudioHandler {
    extern "C" fn impl_stream_did_output_sample_buf(
        &mut self,
        _cmd: Option<&objc::Sel>,
        _stream: &sc::Stream,
        sample_buf: &mut cm::SampleBuf,
        kind: sc::stream::OutputType,
    ) {
        if kind != sc::stream::OutputType::Audio {
            return;
        }

        // Access inner state safely
        let inner = self.inner_mut();

        if let Ok(buf_list) = sample_buf.audio_buf_list_in::<1>(cm::sample_buffer::Flags(0), None, None) {
             let buffer_count = buf_list.list().number_buffers as usize;
             for i in 0..buffer_count {
                 let buffer = &buf_list.list().buffers[i];
                 let data_ptr = buffer.data as *const f32;
                 let byte_count = buffer.data_bytes_size as usize;
                 let float_count = byte_count / 4;
                 
                 if float_count > 0 && !data_ptr.is_null() {
                     unsafe {
                         // Push data to ring buffer
                         let slice = std::slice::from_raw_parts(data_ptr, float_count);
                         println!("[Speaker] Tap received {} samples", slice.len());
                         let _ = inner.producer.push_slice(slice);
                     }
                 }
             }
        }
    }
}

pub struct SpeakerInput {
    cfg: arc::R<sc::StreamCfg>,
    filter: arc::R<sc::ContentFilter>,
}

impl SpeakerInput {
    pub fn new(_device_id: Option<String>) -> Result<Self> {
        println!("[SpeakerInput] Initializing ScreenCaptureKit audio capture...");
        
        let (tx, rx) = std::sync::mpsc::channel();
        sc::ShareableContent::current_with_ch(move |content, error| {
            if let Some(c) = content {
                let _ = tx.send(Ok(c.retained()));
            } else {
                let _ = tx.send(Err(anyhow::anyhow!("SCK error: {:?}", error)));
            }
        });
        
        // Wait for content (blocking is acceptable during init)
        let content = rx.recv().map_err(|e| anyhow::anyhow!("Channel error: {}", e))??;
        let displays = content.displays();
        let display = displays.first().ok_or_else(|| anyhow::anyhow!("No displays"))?;
        
        let empty_windows = ns::Array::<sc::Window>::new();
        let filter = sc::ContentFilter::with_display_excluding_windows(&display, &empty_windows);
        
        let mut cfg = sc::StreamCfg::new();
        cfg.set_captures_audio(true);
        cfg.set_sample_rate(48000);
        cfg.set_channel_count(1);
        cfg.set_excludes_current_process_audio(true);
        
        Ok(Self { cfg, filter })
    }

    pub fn sample_rate(&self) -> f64 {
        self.cfg.sample_rate() as f64
    }

    pub fn stream(self) -> SpeakerStream {
        let buffer_size = 1024 * 128;
        let rb = HeapRb::<f32>::new(buffer_size);
        let (producer, consumer) = rb.split();
        
        let stream = sc::Stream::new(&self.filter, &self.cfg);
        
        // Initialize handler with producer
        let inner = AudioHandlerInner { producer };
        let handler = AudioHandler::with(inner);
        
        let queue = dispatch::Queue::serial_with_ar_pool();
        
        stream.add_stream_output(handler.as_ref(), sc::stream::OutputType::Audio, Some(&queue))
            .expect("Failed to add audio output");
            
        // Start stream (async, ignore future/result for now as we can't await here)
        let _ = stream.start();
        
        SpeakerStream {
            consumer: Some(consumer),
            stream,
            _handler: handler,
        }
    }
}

pub struct SpeakerStream {
    consumer: Option<HeapCons<f32>>,
    stream: arc::R<sc::Stream>,
    _handler: arc::R<AudioHandler>,
}

impl SpeakerStream {
    pub fn sample_rate(&self) -> u32 {
        48000
    }
    
    pub fn take_consumer(&mut self) -> Option<HeapCons<f32>> {
        self.consumer.take()
    }
}

impl Drop for SpeakerStream {
    fn drop(&mut self) {
        let _ = self.stream.stop();
    }
}

unsafe impl Send for SpeakerStream {}
unsafe impl Sync for SpeakerStream {}
