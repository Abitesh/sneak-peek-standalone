use cidre::{av, arc, cat};

pub struct Resampler {
    converter: Option<arc::R<av::AudioConverter>>,
    input_format: arc::R<av::AudioFormat>,
    output_format: arc::R<av::AudioFormat>,
    output_buffer: arc::R<av::AudioPcmBuf>,
    input_rate: f64,
}

fn create_format(rate: f64, channels: u32, is_float: bool) -> Option<arc::R<av::AudioFormat>> {
    let mut asbd = cat::AudioStreamBasicDesc::default();
    asbd.sample_rate = rate;
    // 'lpcm' = 0x6c70636d = 1819304813
    asbd.format = cat::AudioFormat(1819304813); 
    asbd.channels_per_frame = channels;
    asbd.frames_per_packet = 1;
    
    if is_float {
        asbd.format_flags = cat::AudioFormatFlags::IS_FLOAT | cat::AudioFormatFlags::IS_PACKED;
        asbd.bits_per_channel = 32;
        asbd.bytes_per_frame = 4 * channels;
        asbd.bytes_per_packet = 4 * channels;
    } else {
         // Int16
        asbd.format_flags = cat::AudioFormatFlags::IS_SIGNED_INTEGER | cat::AudioFormatFlags::IS_PACKED;
        asbd.bits_per_channel = 16;
        asbd.bytes_per_frame = 2 * channels;
        asbd.bytes_per_packet = 2 * channels;
    }
    
    av::AudioFormat::with_asbd(&asbd)
}

impl Resampler {
    pub fn new(input_rate: f64) -> Result<Self, String> {
        // Output: 16kHz, 1 Channel, Int16
        let output_format = create_format(16000.0, 1, false)
            .ok_or("Failed to create output format")?;

        // Input: Float32, Input Rate, 1 Channel
        let input_format = create_format(input_rate, 1, true)
            .ok_or("Failed to create input format")?;

        if (input_rate - 16000.0).abs() < 1.0 {
            let output_buffer = av::AudioPcmBuf::with_format(&output_format, 1024).unwrap();
            return Ok(Self {
                converter: None,
                input_format,
                output_format,
                output_buffer,
                input_rate
            });
        }

        let converter = av::AudioConverter::with_formats(&input_format, &output_format)
            .ok_or("Failed to create audio converter")?;

        let output_buffer = av::AudioPcmBuf::with_format(&output_format, 2048).unwrap();
        
        println!("Resampler Init: Input Rate: {}", input_rate);

        Ok(Self {
            converter: Some(converter),
            input_format,
            output_format,
            output_buffer,
            input_rate,
        })
    }

    pub fn resample(&mut self, input: &[f32]) -> Result<Vec<i16>, String> {
        if self.converter.is_none() {
            let mut out = Vec::with_capacity(input.len());
            for &sample in input {
                let s = (sample.clamp(-1.0, 1.0) * 32767.0) as i16;
                out.push(s);
            }
            return Ok(out);
        }

        let converter = self.converter.as_ref().unwrap();

        let frame_count = input.len() as u32;
        let mut input_buf = av::AudioPcmBuf::with_format(&self.input_format, frame_count)
            .ok_or("Failed to create input buffer")?;
        input_buf.set_frame_len(frame_count);

        unsafe {
            // using data_f32_mut which returns *mut *mut f32 (array of channels)
            let ptr = input_buf.data_f32_mut();
            if !ptr.is_null() && !(*ptr).is_null() {
                // Get channel 0
                let channel_ptr = *ptr;
                let slice = std::slice::from_raw_parts_mut(channel_ptr, frame_count as usize);
                if slice.len() >= input.len() {
                    slice[..input.len()].copy_from_slice(input);
                } else {
                     return Err("Input buffer too small".to_string());
                }
            } else {
                 return Err("Input buffer ptr null".to_string());
            }
        }

        let ratio = 16000.0 / self.input_rate;
        let expected_out_frames = (frame_count as f64 * ratio).ceil() as u32 + 10;

        if self.output_buffer.frame_capacity() < expected_out_frames {
            self.output_buffer = av::AudioPcmBuf::with_format(&self.output_format, expected_out_frames * 2)
                .ok_or("Failed to reallocate output buffer")?;
        }

        let mut input_consumed = false;
        
        // Fix: Reset output buffer to avoid stale samples
        self.output_buffer.set_frame_len(0);
        
        // Fix: Add explicit type annotation for status
        let result = converter.convert_to_buf_from_buf(&mut self.output_buffer, &input_buf);

        if let Err(e) = result {
             return Err(format!("Resampling failed: {:?}", e));
        }

        let out_frames = self.output_buffer.frame_len() as usize;
        let mut output_bytes = Vec::with_capacity(out_frames);
        
        // Use safe slice if available, or unsafe
        // Attempting to use data_i16_at(0) as it should return Option<&[i16]>
        if let Some(slice) = self.output_buffer.data_i16_at(0) {
             output_bytes.extend_from_slice(&slice[..out_frames]);
        }
        
        if output_bytes.len() != 320 && output_bytes.len() != 640 { // 160 or 320 samples? No, bytes. 160 samples = 320 bytes.
             println!("Resampler Output Unexpected: {} bytes", output_bytes.len());
        }
        
        Ok(output_bytes)
    }
}
