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
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FramesEvent {
    pub rows: Vec<FrameRow>,
    pub total: u64,
    pub errors: u64,
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
                if self.buf.len() >= header.len() {
                    if self.buf.ends_with(header) {
                        if self.buf.len() > header.len() {
                            self.buf.drain(..self.buf.len() - header.len());
                        }
                        self.collecting = true;
                        self.frame_start = abs + 1 - header.len() as u64;
                    } else {
                        self.resync(header);
                    }
                }
            } else {
                self.buf.push(b);
                match self.evaluate(tpl) {
                    Eval::Need => {
                        if self.buf.len() > header.len() && self.buf.ends_with(header) {
                            self.frame_start = abs + 1 - header.len() as u64;
                            self.buf.drain(..self.buf.len() - header.len());
                        }
                    }
                    Eval::TooBig => self.reset(),
                    Eval::Complete => {
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
                        });
                        self.reset();
                    }
                }
            }
        }
    }

    fn resync(&mut self, header: &[u8]) {
        while self.buf.len() > header.len() {
            match self.buf[1..].iter().position(|&c| c == header[0]) {
                Some(pos) => {
                    self.buf.drain(..1 + pos);
                }
                None => {
                    self.buf.clear();
                    return;
                }
            }
        }
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
}

impl ParserEngine {
    pub fn new() -> Self {
        Self {
            templates: Vec::new(),
            machines: Vec::new(),
            total: 0,
            errors: 0,
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
        } = self;
        for m in machines.iter_mut() {
            let tpl = &templates[m.tpl_idx];
            m.feed(tpl, data, base_seq, ts, total, errors, &mut rows);
        }
        rows
    }
}

fn validate(tpl: &FrameTemplate) -> Result<(), String> {
    let b = &tpl.boundary;
    if b.header_bytes.is_empty() {
        return Err(format!("模板[{}]缺少帧头字节", tpl.name));
    }
    if b.header_bytes.len() > 8 {
        return Err(format!("模板[{}]帧头长度不能超过8字节", tpl.name));
    }
    let max_len = b.max_length.unwrap_or(512);
    if max_len < b.header_bytes.len() + 1 || max_len > 65536 {
        return Err(format!("模板[{}]最大帧长不合法", tpl.name));
    }
    match b.mode.as_str() {
        "fixedLength" => {
            let t = b.fixed_length.unwrap_or(0);
            if t < b.header_bytes.len() || t > max_len {
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
        "crc16_modbus" | "crc16_ccitt" => 2,
        "crc32" => 4,
        _ => 1,
    }
}

pub fn checksum_compute(algo: &str, data: &[u8]) -> u64 {
    match algo {
        "sum8" => data.iter().fold(0u8, |acc, &b| acc.wrapping_add(b)) as u64,
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
        _ => f.size.unwrap_or(1),
    }
}

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
}
