use serde::{Deserialize, Serialize};

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ParseRules {
    #[serde(default)]
    pub templates: Vec<FrameTemplate>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FrameTemplate {
    pub id: String,
    pub name: String,
    pub color: String,
    pub enabled: bool,
    pub boundary: Boundary,
    #[serde(default)]
    pub checksum: Option<ChecksumCfg>,
    #[serde(default)]
    pub fields: Vec<FieldDef>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiscCfg {
    #[serde(default)]
    pub offset: usize,
    #[serde(default)]
    pub value: Vec<u8>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Boundary {
    pub mode: String,
    #[serde(default)]
    pub header_bytes: Vec<u8>,
    #[serde(default)]
    pub fixed_length: Option<usize>,
    #[serde(default)]
    pub length_offset: Option<usize>,
    #[serde(default)]
    pub length_size: Option<usize>,
    #[serde(default)]
    pub length_endian: Option<String>,
    #[serde(default)]
    pub length_adjust: Option<i32>,
    #[serde(default)]
    pub footer_bytes: Option<Vec<u8>>,
    #[serde(default)]
    pub max_length: Option<usize>,
    #[serde(default)]
    pub disc_offset: Option<usize>,
    #[serde(default)]
    pub disc_value: Option<Vec<u8>>,
    #[serde(default)]
    pub discs: Vec<DiscCfg>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChecksumCfg {
    pub algo: String,
    #[serde(default)]
    pub coverage_start: i32,
    #[serde(default)]
    pub coverage_end: i32,
    #[serde(default = "default_endian")]
    pub endian: String,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BitsCfg {
    pub index: u8,
    pub count: u8,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FieldDef {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub role: String,
    pub offset: usize,
    #[serde(rename = "type")]
    pub field_type: String,
    #[serde(default = "default_endian")]
    pub endian: String,
    #[serde(default)]
    pub size: Option<usize>,
    #[serde(default)]
    pub scale: Option<f64>,
    #[serde(default)]
    pub offset_value: Option<f64>,
    #[serde(default)]
    pub unit: Option<String>,
    #[serde(default = "default_color")]
    pub color: String,
    #[serde(default)]
    pub bits: Option<BitsCfg>,
    #[serde(default)]
    pub csv_delim: Option<String>,
    #[serde(default)]
    pub csv_type: Option<String>,
    #[serde(default)]
    pub disc: Option<Vec<u8>>,
}

fn default_endian() -> String {
    "little".into()
}

fn default_color() -> String {
    "#8b93a1".into()
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FieldOut {
    pub id: String,
    pub name: String,
    pub raw: f64,
    pub value: f64,
    pub text: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FrameRow {
    pub tpl_id: String,
    pub tpl_name: String,
    pub color: String,
    pub ts_ms: u64,
    pub seq: u64,
    pub len: usize,
    pub valid: bool,
    pub error: Option<String>,
    pub fields: Vec<FieldOut>,
    #[serde(default)]
    pub bytes: Vec<u8>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FramesEvent {
    pub rows: Vec<FrameRow>,
    pub total: u64,
    pub errors: u64,
    pub dropped: u64,
}

enum Eval {
    Need,
    TooBig,
    Complete,
}

struct Machine {
    tpl_idx: usize,
    collecting: bool,
    buf: Vec<u8>,
    frame_start: u64,
}

impl Machine {
    fn feed(
        &mut self,
        tpl: &FrameTemplate,
        data: &[u8],
        base_seq: u64,
        ts: u64,
        total: &mut u64,
        errors: &mut u64,
        dropped: &mut u64,
        rows: &mut Vec<FrameRow>,
    ) {
        if !tpl.enabled {
            return;
        }
        let header = &tpl.boundary.header_bytes;
        for (j, &b) in data.iter().enumerate() {
            let abs = base_seq + j as u64;
            if !self.collecting {
                self.buf.push(b);
                if header.is_empty() {
                    self.collecting = true;
                    self.frame_start = abs;
                } else if self.buf.len() >= header.len() {
                    if self.buf.ends_with(header) {
                        if self.buf.len() > header.len() {
                            *dropped += (self.buf.len() - header.len()) as u64;
                            self.buf.drain(..self.buf.len() - header.len());
                        }
                        self.collecting = true;
                        self.frame_start = abs + 1 - header.len() as u64;
                    } else {
                        *dropped += self.resync(header);
                    }
                }
            } else {
                self.buf.push(b);
                match self.evaluate(tpl) {
                    Eval::Need => {
                        if tpl.boundary.mode != "fixedLength"
                            && !header.is_empty()
                            && self.buf.len() > header.len()
                            && self.buf.ends_with(header)
                        {
                            *dropped += (self.buf.len() - header.len()) as u64;
                            self.frame_start = abs + 1 - header.len() as u64;
                            self.buf.drain(..self.buf.len() - header.len());
                        }
                    }
                    Eval::TooBig => {
                        *dropped += self.buf.len() as u64;
                        self.reset();
                    }
                    Eval::Complete => {
                        if self.reject_by_disc(tpl) {
                            self.reset();
                            continue;
                        }
                        let (valid, err) = verify(tpl, &self.buf);
                        let fields = if valid {
                            decode_fields(tpl, &self.buf)
                        } else {
                            Vec::new()
                        };
                        *total += 1;
                        if !valid {
                            *errors += 1;
                        }
                        rows.push(FrameRow {
                            tpl_id: tpl.id.clone(),
                            tpl_name: tpl.name.clone(),
                            color: tpl.color.clone(),
                            ts_ms: ts,
                            seq: self.frame_start,
                            len: self.buf.len(),
                            valid,
                            error: err,
                            fields,
                            bytes: self.buf.clone(),
                        });
                        self.reset();
                    }
                }
            }
        }
    }

    fn reject_by_disc(&self, tpl: &FrameTemplate) -> bool {
        let b = &tpl.boundary;
        if let (Some(off), Some(val)) = (b.disc_offset, b.disc_value.as_deref()) {
            if !val.is_empty() && self.matches_disc(off, val) {
                return true;
            }
        }
        for d in &b.discs {
            if !d.value.is_empty() && self.matches_disc(d.offset, &d.value) {
                return true;
            }
        }
        for f in &tpl.fields {
            if let Some(val) = f.disc.as_deref() {
                if !val.is_empty() && self.matches_disc(f.offset, val) {
                    return true;
                }
            }
        }
        false
    }

    fn matches_disc(&self, off: usize, val: &[u8]) -> bool {
        if self.buf.len() < off + val.len() {
            return true;
        }
        &self.buf[off..off + val.len()] != val
    }

    fn resync(&mut self, header: &[u8]) -> u64 {
        if header.is_empty() {
            return 0;
        }
        let mut dropped = 0u64;
        while self.buf.len() > header.len() {
            match self.buf[1..].iter().position(|&c| c == header[0]) {
                Some(pos) => {
                    self.buf.drain(..1 + pos);
                    dropped += 1 + pos as u64;
                }
                None => {
                    let n = self.buf.len() as u64;
                    self.buf.clear();
                    return dropped + n;
                }
            }
        }
        dropped
    }

    fn reset(&mut self) {
        self.buf.clear();
        self.collecting = false;
    }

    fn evaluate(&self, tpl: &FrameTemplate) -> Eval {
        let b = &tpl.boundary;
        let max_len = b.max_length.unwrap_or(512);
        match b.mode.as_str() {
            "fixedLength" => {
                let total = b.fixed_length.unwrap_or(0);
                if total == 0 || total > max_len {
                    return Eval::TooBig;
                }
                if self.buf.len() > total {
                    Eval::TooBig
                } else if self.buf.len() == total {
                    Eval::Complete
                } else {
                    Eval::Need
                }
            }
            "lengthField" => {
                if self.buf.len() > max_len {
                    return Eval::TooBig;
                }
                let off = b.length_offset.unwrap_or(0);
                let size = b.length_size.unwrap_or(1);
                if self.buf.len() >= off + size {
                    let raw = read_uint(
                        &self.buf[off..off + size],
                        b.length_endian.as_deref().unwrap_or("little"),
                    );
                    let total_i = raw as i64 + b.length_adjust.unwrap_or(0) as i64;
                    if total_i < 1 || total_i > max_len as i64 {
                        return Eval::TooBig;
                    }
                    let total = total_i as usize;
                    if self.buf.len() > total {
                        Eval::TooBig
                    } else if self.buf.len() == total {
                        Eval::Complete
                    } else {
                        Eval::Need
                    }
                } else {
                    Eval::Need
                }
            }
            "footer" => {
                let footer = b.footer_bytes.as_deref().unwrap_or(&[]);
                if footer.is_empty() {
                    return Eval::TooBig;
                }
                if self.buf.ends_with(footer) {
                    Eval::Complete
                } else if self.buf.len() >= max_len {
                    Eval::TooBig
                } else {
                    Eval::Need
                }
            }
            _ => Eval::TooBig,
        }
    }
}

pub struct ParserEngine {
    templates: Vec<FrameTemplate>,
    machines: Vec<Machine>,
    pub total: u64,
    pub errors: u64,
    pub dropped: u64,
}

impl ParserEngine {
    pub fn new() -> Self {
        Self {
            templates: Vec::new(),
            machines: Vec::new(),
            total: 0,
            errors: 0,
            dropped: 0,
        }
    }

    pub fn reset_stats(&mut self) {
        self.total = 0;
        self.errors = 0;
        self.dropped = 0;
        for m in &mut self.machines {
            m.buf.clear();
            m.collecting = false;
        }
    }

    pub fn set_rules(&mut self, rules: ParseRules) -> Result<(), String> {
        for t in &rules.templates {
            validate(t)?;
        }
        self.templates = rules.templates;
        self.machines = self
            .templates
            .iter()
            .enumerate()
            .map(|(tpl_idx, _)| Machine {
                tpl_idx,
                collecting: false,
                buf: Vec::new(),
                frame_start: 0,
            })
            .collect();
        self.total = 0;
        self.errors = 0;
        self.dropped = 0;
        Ok(())
    }

    pub fn feed(&mut self, data: &[u8], base_seq: u64, ts: u64) -> Vec<FrameRow> {
        let mut rows = Vec::new();
        if data.is_empty() {
            return rows;
        }
        let Self {
            templates,
            machines,
            total,
            errors,
            dropped,
        } = self;
        for m in machines.iter_mut() {
            let tpl = &templates[m.tpl_idx];
            m.feed(tpl, data, base_seq, ts, total, errors, dropped, &mut rows);
        }
        rows
    }
}

fn validate(tpl: &FrameTemplate) -> Result<(), String> {
    let b = &tpl.boundary;
    if b.header_bytes.len() > 8 {
        return Err(format!("模板[{}]帧头长度不能超过8字节", tpl.name));
    }
    let max_len = b.max_length.unwrap_or(512);
    if max_len < (b.header_bytes.len() + 1).min(2) || max_len > 65536 {
        return Err(format!("模板[{}]最大帧长不合法", tpl.name));
    }
    if let (Some(off), Some(val)) = (b.disc_offset, b.disc_value.as_deref()) {
        if !val.is_empty() && off + val.len() < b.header_bytes.len() {
            return Err(format!("模板[{}]识别位与帧头重叠", tpl.name));
        }
    }
    for d in &b.discs {
        if d.value.is_empty() {
            return Err(format!("模板[{}]识别位期望值不能为空", tpl.name));
        }
        if d.offset + d.value.len() < b.header_bytes.len() {
            return Err(format!("模板[{}]识别位与帧头重叠", tpl.name));
        }
    }
    match b.mode.as_str() {
        "fixedLength" => {
            let t = b.fixed_length.unwrap_or(0);
            if t == 0 || t < b.header_bytes.len() || t > max_len {
                return Err(format!(
                    "模板[{}]固定帧长不合法（需≥帧头长度且≤最大帧长）",
                    tpl.name
                ));
            }
        }
        "lengthField" => {
            let off = b.length_offset.unwrap_or(0);
            let size = b.length_size.unwrap_or(1);
            if size != 1 && size != 2 {
                return Err(format!("模板[{}]长度字段宽度只支持1或2字节", tpl.name));
            }
            if off < b.header_bytes.len() {
                return Err(format!("模板[{}]长度字段偏移应≥帧头长度", tpl.name));
            }
            if off + size >= max_len {
                return Err(format!("模板[{}]长度字段越界", tpl.name));
            }
        }
        "footer" => {
            let footer = b.footer_bytes.as_deref().unwrap_or(&[]);
            if footer.is_empty() {
                return Err(format!("模板[{}]缺少帧尾字节", tpl.name));
            }
        }
        other => return Err(format!("模板[{}]未知帧边界模式: {other}", tpl.name)),
    }
    for f in &tpl.fields {
        if f.offset >= max_len {
            return Err(format!(
                "模板[{}]字段[{}]偏移{}超出最大帧长",
                tpl.name, f.name, f.offset
            ));
        }
    }
    Ok(())
}

fn verify(tpl: &FrameTemplate, buf: &[u8]) -> (bool, Option<String>) {
    let Some(ck) = &tpl.checksum else {
        return (true, None);
    };
    if ck.algo == "none" {
        return (true, None);
    }
    let size = checksum_size(&ck.algo);
    let exp_off = match tpl.fields.iter().find(|f| f.role == "checksum") {
        Some(f) => f.offset,
        None => {
            let off = if ck.coverage_end < 0 {
                buf.len() as i32 + ck.coverage_end
            } else {
                ck.coverage_end as i32
            };
            if off < 0 {
                return (false, Some("校验位置越界".into()));
            }
            off as usize
        }
    };
    if exp_off + size > buf.len() {
        return (false, Some("校验字段越界".into()));
    }
    let cov_end = if ck.coverage_end < 0 {
        buf.len().saturating_sub((-ck.coverage_end) as usize)
    } else {
        (ck.coverage_end as usize).min(buf.len())
    };
    let cov_start = (ck.coverage_start.max(0) as usize).min(cov_end);
    if cov_start >= cov_end {
        return (false, Some("校验覆盖区间为空".into()));
    }
    let computed = checksum_compute(&ck.algo, &buf[cov_start..cov_end]);
    let expected = read_uint(&buf[exp_off..exp_off + size], &ck.endian);
    if computed == expected {
        (true, None)
    } else {
        (
            false,
            Some(format!(
                "校验失败(计算{computed:02X}h ≠ 帧内{expected:02X}h)"
            )),
        )
    }
}

fn checksum_size(algo: &str) -> usize {
    match algo {
        "crc16_modbus" | "crc16_ccitt" | "sumadd" => 2,
        "crc32" => 4,
        _ => 1,
    }
}

pub fn checksum_compute(algo: &str, data: &[u8]) -> u64 {
    match algo {
        "sum8" => data.iter().fold(0u8, |acc, &b| acc.wrapping_add(b)) as u64,
        "sumadd" => {
            let mut sc = 0u8;
            let mut ac = 0u8;
            for &b in data {
                sc = sc.wrapping_add(b);
                ac = ac.wrapping_add(sc);
            }
            sc as u64 | ((ac as u64) << 8)
        }
        "xor8" => data.iter().fold(0u8, |acc, &b| acc ^ b) as u64,
        "crc16_modbus" => crc16_modbus(data) as u64,
        "crc16_ccitt" => crc16_ccitt(data) as u64,
        "crc32" => crc32(data) as u64,
        _ => 0,
    }
}

pub fn crc16_modbus(data: &[u8]) -> u16 {
    let mut crc = 0xFFFFu16;
    for &b in data {
        crc ^= b as u16;
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xA001
            } else {
                crc >> 1
            };
        }
    }
    crc
}

fn crc16_ccitt(data: &[u8]) -> u16 {
    let mut crc = 0xFFFFu16;
    for &b in data {
        crc ^= (b as u16) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 {
                (crc << 1) ^ 0x1021
            } else {
                crc << 1
            };
        }
    }
    crc
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFFFFFFu32;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xEDB88320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

fn read_uint(bytes: &[u8], endian: &str) -> u64 {
    let mut v: u64 = 0;
    if endian == "big" {
        for &b in bytes {
            v = (v << 8) | b as u64;
        }
    } else {
        for (i, &b) in bytes.iter().enumerate() {
            v |= (b as u64) << (8 * i);
        }
    }
    v
}

fn type_size(f: &FieldDef) -> usize {
    match f.field_type.as_str() {
        "uint8" | "int8" | "bits" => 1,
        "uint16" | "int16" => 2,
        "uint32" | "int32" | "float32" => 4,
        "float64" => 8,
        "bcd" => f.size.unwrap_or(2),
        "ascii" => f.size.unwrap_or(4),
        "csv" => 0,
        _ => f.size.unwrap_or(1),
    }
}

fn csv_delim_of(f: &FieldDef) -> Vec<u8> {
    let d = f.csv_delim.as_deref().unwrap_or(",");
    d.bytes().collect()
}

fn parse_csv_num(s: &str, ty: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    match ty {
        "int8" => t.parse::<i8>().ok().map(|v| v as f64),
        "uint8" => t.parse::<u8>().ok().map(|v| v as f64),
        "int16" => t.parse::<i16>().ok().map(|v| v as f64),
        "uint16" => t.parse::<u16>().ok().map(|v| v as f64),
        "int32" => t.parse::<i32>().ok().map(|v| v as f64),
        "uint32" => t.parse::<u32>().ok().map(|v| v as f64),
        "float64" => t.parse::<f64>().ok(),
        _ => t.parse::<f32>().ok().map(|v| v as f64),
    }
}

const CSV_MAX_CH: usize = 64;

fn decode_numeric(f: &FieldDef, bytes: &[u8]) -> f64 {
    match f.field_type.as_str() {
        "int8" => bytes[0] as i8 as f64,
        "int16" => {
            let u = read_uint(&bytes[..2], &f.endian) as u16;
            u as i16 as f64
        }
        "int32" => {
            let u = read_uint(&bytes[..4], &f.endian) as u32;
            u as i32 as f64
        }
        "float32" => {
            let u = read_uint(&bytes[..4], &f.endian) as u32;
            f32::from_bits(u) as f64
        }
        "float64" => {
            let u = read_uint(&bytes[..8], &f.endian);
            f64::from_bits(u)
        }
        "bits" => {
            let (index, count) = f
                .bits
                .as_ref()
                .map(|b| (b.index, b.count))
                .unwrap_or((0, 1));
            let mask = if count >= 8 { 0xFFu16 } else { (1u16 << count) - 1 };
            ((bytes[0] >> index) & mask as u8) as f64
        }
        _ => read_uint(bytes, &f.endian) as f64,
    }
}

fn decode_fields(tpl: &FrameTemplate, buf: &[u8]) -> Vec<FieldOut> {
    let mut out = Vec::new();
    for f in &tpl.fields {
        if !matches!(f.role.as_str(), "data" | "payload" | "id" | "seq" | "length") {
            continue;
        }
        if f.field_type == "csv" {
            let delim = csv_delim_of(f);
            let rt = reserved_tail_len(tpl);
            let end = buf.len().saturating_sub(rt).max(f.offset);
            if f.offset < end {
                let sl = &buf[f.offset..end];
                let text = String::from_utf8_lossy(sl).to_string();
                let pat = String::from_utf8_lossy(&delim).to_string();
                let segs: Vec<&str> = if pat.is_empty() {
                    text.split(',').collect()
                } else {
                    text.split(pat.as_str()).collect()
                };
                let ty = f.csv_type.as_deref().unwrap_or("float32");
                let name = f.name.clone();
                let scale = f.scale.unwrap_or(1.0);
                let offv = f.offset_value.unwrap_or(0.0);
                out.push(FieldOut {
                    id: f.id.clone(),
                    name: name.clone(),
                    raw: 0.0,
                    value: 0.0,
                    text: Some(text.clone()),
                });
                for (i, seg) in segs.iter().enumerate() {
                    if i >= CSV_MAX_CH {
                        break;
                    }
                    if let Some(v) = parse_csv_num(seg, ty) {
                        out.push(FieldOut {
                            id: format!("{}#{}", f.id, i + 1),
                            name: format!("{}{}", name, i + 1),
                            raw: v,
                            value: v * scale + offv,
                            text: None,
                        });
                    }
                }
            }
            continue;
        }
        let size = type_size(f);
        if f.offset + size > buf.len() {
            continue;
        }
        let sl = &buf[f.offset..f.offset + size];
        let (raw, text) = match f.field_type.as_str() {
            "ascii" => (0.0, Some(String::from_utf8_lossy(sl).to_string())),
            "bcd" => {
                let mut v: u64 = 0;
                for &b in sl {
                    v = v * 100 + ((b >> 4) as u64) * 10 + (b & 0x0F) as u64;
                }
                (v as f64, None)
            }
            _ => (decode_numeric(f, sl), None),
        };
        let value = raw * f.scale.unwrap_or(1.0) + f.offset_value.unwrap_or(0.0);
        out.push(FieldOut {
            id: f.id.clone(),
            name: f.name.clone(),
            raw,
            value,
            text,
        });
    }
    out
}

fn reserved_tail_len(tpl: &FrameTemplate) -> usize {
    let mut rt = 0;
    if let Some(ck) = &tpl.checksum {
        if ck.algo != "none" && ck.coverage_end < 0 {
            rt += checksum_size(&ck.algo);
        }
    }
    if tpl.boundary.mode == "footer" {
        if let Some(fb) = &tpl.boundary.footer_bytes {
            rt += fb.len();
        }
    }
    rt
}

#[cfg(test)]
mod tests {
    use super::*;

    fn demo_rules() -> ParseRules {
        ParseRules {
            templates: vec![
                FrameTemplate {
                    id: "a".into(),
                    name: "A帧".into(),
                    color: "#4e9cef".into(),
                    enabled: true,
                    boundary: Boundary {
                        mode: "lengthField".into(),
                        header_bytes: vec![0xAA, 0x55],
                        fixed_length: None,
                        length_offset: Some(2),
                        length_size: Some(1),
                        length_endian: Some("little".into()),
                        length_adjust: Some(3),
                        footer_bytes: None,
                        max_length: Some(512),
                        disc_offset: None,
                        disc_value: None,
                        discs: Vec::new(),
                    },
                    checksum: Some(ChecksumCfg {
                        algo: "sum8".into(),
                        coverage_start: 0,
                        coverage_end: -1,
                        endian: "little".into(),
                    }),
                    fields: vec![
                        field("a-seq", "序号", "seq", 3, "uint16", "little"),
                        field("a-temp", "温度", "data", 5, "float32", "little"),
                    ],
                },
                FrameTemplate {
                    id: "b".into(),
                    name: "B帧".into(),
                    color: "#e5534b".into(),
                    enabled: true,
                    boundary: Boundary {
                        mode: "fixedLength".into(),
                        header_bytes: vec![0xBB, 0x66],
                        fixed_length: Some(12),
                        length_offset: None,
                        length_size: None,
                        length_endian: None,
                        length_adjust: None,
                        footer_bytes: None,
                        max_length: Some(512),
                        disc_offset: None,
                        disc_value: None,
                        discs: Vec::new(),
                    },
                    checksum: Some(ChecksumCfg {
                        algo: "crc16_modbus".into(),
                        coverage_start: 0,
                        coverage_end: -2,
                        endian: "little".into(),
                    }),
                    fields: vec![field("b-roll", "Roll", "data", 4, "int16", "big")],
                },
            ],
        }
    }

    fn field(
        id: &str,
        name: &str,
        role: &str,
        offset: usize,
        ty: &str,
        endian: &str,
    ) -> FieldDef {
        FieldDef {
            id: id.into(),
            name: name.into(),
            role: role.into(),
            offset,
            field_type: ty.into(),
            endian: endian.into(),
            size: None,
            scale: None,
            offset_value: None,
            unit: None,
            color: "#888888".into(),
            bits: None,
            csv_delim: None,
            csv_type: None,
            disc: None,
        }
    }

    fn build_frame_a(seq: u16, temp: f32) -> Vec<u8> {
        let mut f = vec![0xAA, 0x55, 11u8];
        f.extend_from_slice(&seq.to_le_bytes());
        f.extend_from_slice(&temp.to_le_bytes());
        f.extend_from_slice(&40.0f32.to_le_bytes());
        let sum = f.iter().fold(0u8, |acc, &b| acc.wrapping_add(b));
        f.push(sum);
        f
    }

    fn build_frame_b(roll: i16) -> Vec<u8> {
        let mut f = vec![0xBB, 0x66, 0x00, 0x01];
        f.extend_from_slice(&roll.to_be_bytes());
        f.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]);
        let crc = crc16_modbus(&f);
        f.extend_from_slice(&crc.to_le_bytes());
        f
    }

    #[test]
    fn mixed_stream_dual_template() {
        let mut eng = ParserEngine::new();
        eng.set_rules(demo_rules()).unwrap();

        let a1 = build_frame_a(1, 25.5);
        let b1 = build_frame_b(-123);
        let a2 = build_frame_a(2, -0.5);
        let mut stream = Vec::new();
        stream.extend_from_slice(&[0xFF, 0x00]);
        stream.extend_from_slice(&a1);
        stream.extend_from_slice(&b1);
        stream.extend_from_slice(&a2);
        let rows = eng.feed(&stream, 0, 100);

        assert_eq!(rows.len(), 3, "应解析出3帧: {rows:?}");
        let a_rows: Vec<&FrameRow> = rows.iter().filter(|r| r.tpl_id == "a").collect();
        let b_rows: Vec<&FrameRow> = rows.iter().filter(|r| r.tpl_id == "b").collect();
        assert_eq!(a_rows.len(), 2);
        assert_eq!(b_rows.len(), 1);
        assert!(a_rows.iter().all(|r| r.valid));
        assert!(b_rows[0].valid);

        let seq = a_rows[0].fields.iter().find(|f| f.id == "a-seq").unwrap();
        assert_eq!(seq.raw, 1.0);
        let temp = a_rows[0].fields.iter().find(|f| f.id == "a-temp").unwrap();
        assert!((temp.raw - 25.5).abs() < 1e-6);
        let roll = b_rows[0].fields.iter().find(|f| f.id == "b-roll").unwrap();
        assert_eq!(roll.raw, -123.0);
        assert_eq!(eng.total, 3);
        assert_eq!(eng.errors, 0);
    }

    #[test]
    fn corrupted_frame_counted_as_error() {
        let mut eng = ParserEngine::new();
        eng.set_rules(demo_rules()).unwrap();
        let mut bad = build_frame_a(7, 30.0);
        let good = build_frame_a(8, 31.0);
        let len = bad.len();
        bad[len - 2] ^= 0xFF;
        let mut stream = bad;
        stream.extend_from_slice(&good);
        let rows = eng.feed(&stream, 0, 100);
        assert_eq!(rows.len(), 2);
        assert!(!rows[0].valid);
        assert!(rows[0].error.is_some());
        assert!(rows[1].valid);
        assert_eq!(eng.errors, 1);
    }

    #[test]
    fn header_split_across_chunks() {
        let mut eng = ParserEngine::new();
        eng.set_rules(demo_rules()).unwrap();
        let frame = build_frame_a(9, 10.0);
        let (s1, s2) = frame.split_at(1);
        let rows1 = eng.feed(s1, 0, 1);
        assert!(rows1.is_empty());
        let rows2 = eng.feed(s2, 1, 2);
        assert_eq!(rows2.len(), 1);
        assert!(rows2[0].valid);
        assert_eq!(rows2[0].seq, 0);
    }

    #[test]
    fn false_header_resync() {
        let mut eng = ParserEngine::new();
        eng.set_rules(demo_rules()).unwrap();
        let good = build_frame_a(3, 1.0);
        let mut stream = vec![0xAA, 0x55, 0xF0, 0x01, 0x02];
        stream.extend_from_slice(&good);
        let rows = eng.feed(&stream, 0, 100);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].valid);
        assert_eq!(eng.errors, 0);
    }

    #[test]
    fn b_frame_isolated() {
        let mut eng = ParserEngine::new();
        eng.set_rules(demo_rules()).unwrap();
        let frame = build_frame_b(-123);
        let rows = eng.feed(&frame, 0, 1);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].valid);
    }

    fn wit_rules() -> ParseRules {
        let mk = |id: &str, ty: u8| FrameTemplate {
            id: id.into(),
            name: id.into(),
            color: "#4e9cef".into(),
            enabled: true,
            boundary: Boundary {
                mode: "fixedLength".into(),
                header_bytes: vec![0x55],
                fixed_length: Some(6),
                length_offset: None,
                length_size: None,
                length_endian: None,
                length_adjust: None,
                footer_bytes: None,
                max_length: Some(16),
                disc_offset: Some(1),
                disc_value: Some(vec![ty]),
                discs: Vec::new(),
            },
            checksum: Some(ChecksumCfg {
                algo: "sum8".into(),
                coverage_start: 0,
                coverage_end: -1,
                endian: "little".into(),
            }),
            fields: vec![FieldDef {
                id: format!("f-{id}"),
                name: "D1".into(),
                role: "data".into(),
                offset: 2,
                field_type: "uint8".into(),
                endian: "little".into(),
                size: None,
                scale: None,
                offset_value: None,
                unit: None,
                color: "#3fb950".into(),
                bits: None,
                csv_delim: None,
                csv_type: None,
                disc: None,
            }],
        };
        ParseRules {
            templates: vec![mk("t51", 0x51), mk("t52", 0x52), mk("t53", 0x53)],
        }
    }

    fn build_wit(ty: u8, d1: u8, d2: u8, d3: u8) -> Vec<u8> {
        let mut f = vec![0x55, ty, d1, d2, d3];
        let sum = f.iter().fold(0u8, |a, &b| a.wrapping_add(b));
        f.push(sum);
        f
    }

    #[test]
    fn wit_back_to_back_stream_with_0x55_data() {
        let mut eng = ParserEngine::new();
        eng.set_rules(wit_rules()).unwrap();
        let mut stream = Vec::new();
        for i in 0u8..9 {
            let ty = 0x51 + (i % 3);
            stream.extend_from_slice(&build_wit(ty, 0x55, i, 0x00));
        }
        let rows = eng.feed(&stream, 0, 1);
        assert_eq!(rows.len(), 9, "{rows:?}");
        assert!(rows.iter().all(|r| r.valid), "{rows:?}");
        assert_eq!(eng.errors, 0);
    }

    #[test]
    fn multi_disc_list_rejects_mismatch() {
        let mut rules = wit_rules();
        rules.templates.truncate(1);
        let t = &mut rules.templates[0];
        t.fields.push(FieldDef {
            id: "f-ty".into(),
            name: "TYPE".into(),
            role: "id".into(),
            offset: 1,
            field_type: "uint8".into(),
            endian: "little".into(),
            size: None,
            scale: None,
            offset_value: None,
            unit: None,
            color: "#f0883e".into(),
            bits: None,
            csv_delim: None,
            csv_type: None,
            disc: Some(vec![0x51]),
        });
        t.fields.push(FieldDef {
            id: "f-d3".into(),
            name: "D3".into(),
            role: "data".into(),
            offset: 4,
            field_type: "uint8".into(),
            endian: "little".into(),
            size: None,
            scale: None,
            offset_value: None,
            unit: None,
            color: "#3fb950".into(),
            bits: None,
            csv_delim: None,
            csv_type: None,
            disc: Some(vec![0xAA]),
        });
        let mut eng = ParserEngine::new();
        eng.set_rules(rules).unwrap();
        let mut stream = Vec::new();
        stream.extend_from_slice(&build_wit(0x51, 0x55, 1, 0xAA));
        stream.extend_from_slice(&build_wit(0x51, 0x55, 2, 0x00));
        stream.extend_from_slice(&build_wit(0x52, 0x55, 3, 0xAA));
        stream.extend_from_slice(&build_wit(0x51, 0x55, 4, 0xAA));
        let rows = eng.feed(&stream, 0, 1);
        assert_eq!(rows.len(), 2, "{rows:?}");
        assert!(rows.iter().all(|r| r.valid), "{rows:?}");
        assert_eq!(eng.errors, 0);
    }

    fn ano_rules() -> ParseRules {
        ParseRules {
            templates: vec![FrameTemplate {
                id: "v7".into(),
                name: "匿名V7".into(),
                color: "#4e9cef".into(),
                enabled: true,
                boundary: Boundary {
                    mode: "lengthField".into(),
                    header_bytes: vec![0xAA],
                    fixed_length: None,
                    length_offset: Some(3),
                    length_size: Some(1),
                    length_endian: None,
                    length_adjust: Some(6),
                    footer_bytes: None,
                    max_length: Some(64),
                    disc_offset: None,
                    disc_value: None,
                    discs: Vec::new(),
                },
                checksum: Some(ChecksumCfg {
                    algo: "sumadd".into(),
                    coverage_start: 0,
                    coverage_end: -2,
                    endian: "little".into(),
                }),
                fields: vec![FieldDef {
                    id: "f-id".into(),
                    name: "功能码".into(),
                    role: "payload".into(),
                    offset: 2,
                    field_type: "uint8".into(),
                    endian: "little".into(),
                    size: None,
                    scale: None,
                    offset_value: None,
                    unit: None,
                    color: "#4e9cef".into(),
                    bits: None,
                    csv_delim: None,
                    csv_type: None,
                    disc: None,
                }],
            }],
        }
    }

    fn build_ano(data: &[u8], daddr: u8, fid: u8) -> Vec<u8> {
        let mut f = vec![0xAA, daddr, fid, data.len() as u8];
        f.extend_from_slice(data);
        let mut sc = 0u8;
        let mut ac = 0u8;
        for &b in &f {
            sc = sc.wrapping_add(b);
            ac = ac.wrapping_add(sc);
        }
        f.push(sc);
        f.push(ac);
        f
    }

    #[test]
    fn ano_v7_sumadd_verify() {
        let mut eng = ParserEngine::new();
        eng.set_rules(ano_rules()).unwrap();
        let frame = build_ano(&[1, 2, 3, 4, 5, 6, 7, 8], 0xFF, 0xF1);
        assert_eq!(frame.len(), 14);
        let rows = eng.feed(&frame, 0, 1);
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert!(rows[0].valid);
        assert_eq!(rows[0].len, frame.len());
        assert_eq!(rows[0].bytes, frame);
        let id = rows[0].fields.iter().find(|f| f.id == "f-id").unwrap();
        assert_eq!(id.raw, 241.0);
        assert_eq!(eng.errors, 0);
        assert_eq!(eng.dropped, 0);

        let mut bad = build_ano(&[9, 9, 9], 0xFF, 0x03);
        let n = bad.len();
        bad[n - 3] ^= 0x01;
        let rows = eng.feed(&bad, 100, 2);
        assert_eq!(rows.len(), 1);
        assert!(!rows[0].valid);
        assert!(rows[0].error.is_some());
        assert_eq!(eng.errors, 1);
    }

    #[test]
    fn dropped_counts_junk_bytes() {
        let mut eng = ParserEngine::new();
        eng.set_rules(ano_rules()).unwrap();
        let mut stream = vec![0x11, 0x22, 0x33];
        stream.extend_from_slice(&build_ano(&[7, 7], 0xFF, 0xF2));
        let rows = eng.feed(&stream, 0, 1);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].valid);
        assert!(eng.dropped >= 3, "帧前杂散字节应计数, got {}", eng.dropped);
    }

    fn comma_rules() -> ParseRules {
        ParseRules {
            templates: vec![FrameTemplate {
                id: "csv".into(),
                name: "逗号帧".into(),
                color: "#39c5cf".into(),
                enabled: true,
                boundary: Boundary {
                    mode: "footer".into(),
                    header_bytes: Vec::new(),
                    fixed_length: None,
                    length_offset: None,
                    length_size: None,
                    length_endian: None,
                    length_adjust: None,
                    footer_bytes: Some(vec![0x2C]),
                    max_length: Some(32),
                    disc_offset: None,
                    disc_value: None,
                    discs: Vec::new(),
                },
                checksum: None,
                fields: vec![FieldDef {
                    id: "v".into(),
                    name: "数值".into(),
                    role: "data".into(),
                    offset: 0,
                    field_type: "ascii".into(),
                    endian: "little".into(),
                    size: Some(4),
                    scale: None,
                    offset_value: None,
                    unit: Some("cm".into()),
                    color: "#3fb950".into(),
                    bits: None,
                    csv_delim: None,
                    csv_type: None,
                    disc: None,
                }],
            }],
        }
    }

    #[test]
    fn no_header_comma_delimited_ascii_frames() {
        let mut eng = ParserEngine::new();
        eng.set_rules(comma_rules()).unwrap();
        let stream = b"12.3,12.6,15.6,17.6,".to_vec();
        let rows = eng.feed(&stream, 0, 1);
        assert_eq!(rows.len(), 4, "应为4个逗号分隔帧: {rows:?}");
        for (i, r) in rows.iter().enumerate() {
            assert!(r.valid, "第{i}帧应有效: {:?}", r.error);
            assert_eq!(r.len, 5);
            let txt = r.fields.iter().find(|f| f.id == "v").unwrap().text.as_deref();
            let want = ["12.3", "12.6", "15.6", "17.6"][i];
            assert_eq!(txt, Some(want));
        }
        assert_eq!(eng.dropped, 0);
        assert_eq!(eng.errors, 0);
    }

    fn v7_disc_rules() -> ParseRules {
        let tpl = |id: &str, name: &str, fid_val: u8| FrameTemplate {
            id: id.into(),
            name: name.into(),
            color: "#4e9cef".into(),
            enabled: true,
            boundary: Boundary {
                mode: "lengthField".into(),
                header_bytes: vec![0xAA],
                fixed_length: None,
                length_offset: Some(3),
                length_size: Some(1),
                length_endian: None,
                length_adjust: Some(6),
                footer_bytes: None,
                max_length: Some(64),
                disc_offset: Some(2),
                disc_value: Some(vec![fid_val]),
                discs: Vec::new(),
            },
            checksum: Some(ChecksumCfg {
                algo: "sumadd".into(),
                coverage_start: 0,
                coverage_end: -2,
                endian: "little".into(),
            }),
            fields: vec![FieldDef {
                id: format!("{id}-fid"),
                name: "功能码".into(),
                role: "payload".into(),
                offset: 2,
                field_type: "uint8".into(),
                endian: "little".into(),
                size: None,
                scale: None,
                offset_value: None,
                unit: None,
                color: "#4e9cef".into(),
                bits: None,
                csv_delim: None,
                csv_type: None,
                disc: None,
            }],
        };
        ParseRules {
            templates: vec![
                tpl("v7-01", "惯性传感", 0x01),
                tpl("v7-03", "姿态欧拉", 0x03),
            ],
        }
    }

    #[test]
    fn v7_like_dual_template_discriminator() {
        let mut eng = ParserEngine::new();
        eng.set_rules(v7_disc_rules()).unwrap();
        let f1 = build_ano(&[1, 2, 3, 4, 5], 0xFF, 0x03);
        let f2 = build_ano(&[9, 8, 7], 0xFF, 0x01);
        let mut stream = Vec::new();
        stream.extend_from_slice(&f1);
        stream.extend_from_slice(&f2);
        let rows = eng.feed(&stream, 0, 1);
        assert_eq!(rows.len(), 2, "同头不同功能码应各归其模板: {rows:?}");
        let r0 = rows.iter().find(|r| r.tpl_id == "v7-03").expect("应有欧拉帧行");
        assert!(r0.valid);
        assert_eq!(r0.len, f1.len());
        let r1 = rows.iter().find(|r| r.tpl_id == "v7-01").expect("应有惯性帧行");
        assert!(r1.valid);
        assert_eq!(r1.len, f2.len());
        assert_eq!(eng.total, 2);
        assert_eq!(eng.errors, 0);
    }

    #[test]
    fn disc_mismatched_frame_rejected() {
        let mut eng = ParserEngine::new();
        eng.set_rules(v7_disc_rules()).unwrap();
        let mut eng2 = ParserEngine::new();
        eng2.set_rules(v7_disc_rules()).unwrap();
        let other = build_ano(&[5, 5, 5], 0xFF, 0x02);
        let rows = eng.feed(&other, 0, 1);
        assert!(rows.is_empty(), "非本模板帧应被识别位拒绝");
        assert_eq!(eng.dropped, 0, "非本模板帧不应计为杂散数据");
        let rows2 = eng2.feed(&other, 0, 1);
        assert!(rows2.is_empty());
    }

    fn csv_rules(delim: &str, ty: &str) -> ParseRules {
        ParseRules {
            templates: vec![FrameTemplate {
                id: "csvf".into(),
                name: "自适应文本帧".into(),
                color: "#39c5cf".into(),
                enabled: true,
                boundary: Boundary {
                    mode: "footer".into(),
                    header_bytes: Vec::new(),
                    fixed_length: None,
                    length_offset: None,
                    length_size: None,
                    length_endian: None,
                    length_adjust: None,
                    footer_bytes: Some(vec![0x0A]),
                    max_length: Some(128),
                    disc_offset: None,
                    disc_value: None,
                    discs: Vec::new(),
                },
                checksum: None,
                fields: vec![FieldDef {
                    id: "vals".into(),
                    name: "通道".into(),
                    role: "data".into(),
                    offset: 0,
                    field_type: "csv".into(),
                    endian: "little".into(),
                    size: None,
                    scale: None,
                    offset_value: None,
                    unit: None,
                    color: "#3fb950".into(),
                    bits: None,
                    csv_delim: Some(delim.into()),
                    csv_type: Some(ty.into()),
                    disc: None,
                }],
            }],
        }
    }

    #[test]
    fn csv_adaptive_float_channels() {
        let mut eng = ParserEngine::new();
        eng.set_rules(csv_rules(",", "float32")).unwrap();
        let rows = eng.feed(b"12.5,-3.0,1001.75,0.5\n", 0, 1);
        assert_eq!(rows.len(), 1);
        let r = &rows[0];
        assert!(r.valid);
        let ch = |k: &str| r.fields.iter().find(|f| f.id == k).map(|f| f.value);
        assert_eq!(ch("vals#1"), Some(12.5));
        assert_eq!(ch("vals#2"), Some(-3.0));
        assert_eq!(ch("vals#3"), Some(1001.75));
        assert_eq!(ch("vals#4"), Some(0.5));
        assert!(r.fields.iter().find(|f| f.id == "vals#5").is_none());
        let rows2 = eng.feed(b"7.25,8.5\n", 0, 2);
        let r2 = &rows2[0];
        assert_eq!(
            r2.fields.iter().find(|f| f.id == "vals#2").map(|f| f.value),
            Some(8.5)
        );
        assert!(r2.fields.iter().find(|f| f.id == "vals#3").is_none());
    }

    #[test]
    fn csv_custom_delim_and_uint8() {
        let mut eng = ParserEngine::new();
        eng.set_rules(csv_rules("\\", "uint8")).unwrap();
        let rows = eng.feed(b"200\\1\\55\n", 0, 1);
        assert_eq!(rows.len(), 1);
        let r = &rows[0];
        assert!(r.valid);
        let ch = |k: &str| r.fields.iter().find(|f| f.id == k).map(|f| f.value);
        assert_eq!(ch("vals#1"), Some(200.0));
        assert_eq!(ch("vals#2"), Some(1.0));
        assert_eq!(ch("vals#3"), Some(55.0));
        assert_eq!(ch("vals#4"), None);
    }
}
