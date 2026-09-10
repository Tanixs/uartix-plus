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

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiscCfg {
    #[serde(default)]
    pub offset: usize,
    #[serde(default)]
    pub value: Vec<u8>,
    /// 逐字节位掩码（与 value 等长或更短，缺位按 0xFF）：`(帧字节 & m) == (value & m)`。
    /// 用于「任意从站地址」（该位掩码 0x00）与「任意异常响应 FC=FC|0x80」（value 0x80 / mask 0x80）。
    #[serde(default)]
    pub mask: Option<Vec<u8>>,
}

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Boundary {
    pub mode: String,
    #[serde(default)]
    pub header_bytes: Vec<u8>,
    /// 帧头逐字节位掩码，见 DiscCfg::mask。缺省 = 全 0xFF = 精确匹配（旧模板行为不变）。
    #[serde(default)]
    pub header_mask: Option<Vec<u8>>,
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
    /// 长度域倍率：总长 = ceil(长度值 × scale) + adjust。缺省 1.0。
    /// Modbus FC01/02 响应的长度域是「位数」而非字节数 → scale = 0.125。
    #[serde(default)]
    pub length_scale: Option<f64>,
    #[serde(default)]
    pub footer_bytes: Option<Vec<u8>>,
    #[serde(default)]
    pub max_length: Option<usize>,
    #[serde(default)]
    pub disc_offset: Option<usize>,
    #[serde(default)]
    pub disc_value: Option<Vec<u8>>,
    #[serde(default)]
    pub disc_mask: Option<Vec<u8>>,
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
    #[serde(default)]
    pub offset: i64,
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
    #[serde(default)]
    pub span_tail: Option<bool>,
    #[serde(default)]
    pub span_elem: Option<String>,
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
    #[serde(default, with = "crate::b64")]
    pub bytes: Vec<u8>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FramesEvent {
    pub rows: Vec<FrameRow>,
    pub total: u64,
    pub errors: u64,
    pub dropped: u64,
    /// Rust 侧发出事件的时刻：前端用于测量 IPC 投递延迟（诊断事件积压）
    pub emit_ts: u64,
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
        self.scan(tpl, data, base_seq, ts, total, errors, dropped, rows, 0);
    }

    /// `depth` = 校验失败后「后退一字节重找帧头」的递归层数（错位自愈，见 Complete 分支）。
    #[allow(clippy::too_many_arguments)]
    fn scan(
        &mut self,
        tpl: &FrameTemplate,
        data: &[u8],
        base_seq: u64,
        ts: u64,
        total: &mut u64,
        errors: &mut u64,
        dropped: &mut u64,
        rows: &mut Vec<FrameRow>,
        depth: u32,
    ) {
        if !tpl.enabled {
            return;
        }
        let header = &tpl.boundary.header_bytes;
        let hmask = tpl.boundary.header_mask.as_deref();
        for (j, &b) in data.iter().enumerate() {
            let abs = base_seq + j as u64;
            if !self.collecting {
                self.buf.push(b);
                if header.is_empty() {
                    self.collecting = true;
                    self.frame_start = abs;
                } else if self.buf.len() >= header.len() {
                    if tail_match(&self.buf, header, hmask) {
                        if self.buf.len() > header.len() {
                            *dropped += (self.buf.len() - header.len()) as u64;
                            self.buf.drain(..self.buf.len() - header.len());
                        }
                        self.collecting = true;
                        self.frame_start = abs + 1 - header.len() as u64;
                    } else {
                        *dropped += self.resync(header.len());
                    }
                }
            } else {
                self.buf.push(b);
                match self.evaluate(tpl) {
                    Eval::Need => {
                        // 帧中途重锚定：仅当帧首字节是**精确值**时才允许。
                        // 通配帧首（如 Modbus「任意从站地址」）时，数据区里随便一对
                        // [任意字节, 功能码] 都会被误认成新帧头，把好帧拦腰截断；
                        // 这类模板的对齐交给长度+校验，最多损失一帧而不是错帧连出。
                        let strong_anchor = hmask
                            .map(|m| m.first().copied().unwrap_or(0xFF) == 0xFF)
                            .unwrap_or(true);
                        if tpl.boundary.mode != "fixedLength"
                            && strong_anchor
                            && !header.is_empty()
                            && self.buf.len() > header.len()
                            && tail_match(&self.buf, header, hmask)
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
                        // 先把帧字节取出：后续重扫会改动 self.buf，而行内容必须是本帧原文
                        let row_bytes = std::mem::take(&mut self.buf);
                        let row_seq = self.frame_start;
                        let (valid, err) = verify(tpl, &row_bytes);
                        let mut keep_state = false;
                        if !valid && depth < RESCAN_DEPTH && !header.is_empty() {
                            // 校验不过有两种可能：真是坏帧，或者只是帧起点错位。
                            // 错位时按旧逻辑整段丢弃，会把紧随其后（甚至交叠）的好帧一起吞掉
                            // ——Modbus 这类"帧首通配 + 数据区常出现帧头样式"的协议尤其明显。
                            // 故后退一字节在已收字节里重扫：扫出自洽解就采用它，且不记这条坏帧。
                            self.collecting = false;
                            let mut sub_rows: Vec<FrameRow> = Vec::new();
                            let (mut s_total, mut s_err, mut s_drop) = (0u64, 0u64, 0u64);
                            self.scan(
                                tpl,
                                &row_bytes[1..],
                                row_seq + 1,
                                ts,
                                &mut s_total,
                                &mut s_err,
                                &mut s_drop,
                                &mut sub_rows,
                                depth + 1,
                            );
                            *dropped += s_drop + 1;
                            if sub_rows.iter().any(|r| r.valid) {
                                *total += s_total;
                                *errors += s_err;
                                rows.extend(sub_rows);
                                continue; // 状态沿用子扫描结果（对齐更可信）
                            }
                            // 无自洽解 → 确属坏帧：仍记本帧原文，但保留子扫描推进的状态
                            keep_state = true;
                        }
                        let fields = if valid {
                            decode_fields(tpl, &row_bytes)
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
                            seq: row_seq,
                            len: row_bytes.len(),
                            valid,
                            error: err,
                            fields,
                            bytes: row_bytes,
                        });
                        if !keep_state {
                            self.reset();
                        }
                    }
                }
            }
        }
    }

    fn reject_by_disc(&self, tpl: &FrameTemplate) -> bool {
        let b = &tpl.boundary;
        if let (Some(off), Some(val)) = (b.disc_offset, b.disc_value.as_deref()) {
            if !val.is_empty() && self.matches_disc(off, val, b.disc_mask.as_deref()) {
                return true;
            }
        }
        for d in &b.discs {
            if !d.value.is_empty() && self.matches_disc(d.offset, &d.value, d.mask.as_deref()) {
                return true;
            }
        }
        for f in &tpl.fields {
            if let Some(val) = f.disc.as_deref() {
                if !val.is_empty()
                    && f.offset >= 0
                    && self.matches_disc(f.offset as usize, val, None)
                {
                    return true;
                }
            }
        }
        false
    }

    fn matches_disc(&self, off: usize, val: &[u8], mask: Option<&[u8]>) -> bool {
        !byte_match(&self.buf, off, val, mask)
    }

    /// 帧头尚未凑满时的重同步：任何未来的帧头都必须起始于末尾 header_len-1 字节之内，
    /// 因此只保留这段候选前缀、丢弃更老的字节即可——既不丢帧也不需要猜测首字节。
    /// （旧实现按「找下一个首字节」丢弃，会把首字节已入缓冲的那一帧整帧吞掉。）
    fn resync(&mut self, header_len: usize) -> u64 {
        let keep = header_len.saturating_sub(1);
        let drop = self.buf.len().saturating_sub(keep);
        if drop > 0 {
            self.buf.drain(..drop);
        }
        drop as u64
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
                    // 总长 = ceil(长度值 × scale) + adjust（scale 缺省 1.0，旧模板不受影响）
                    let scaled = match b.length_scale {
                        Some(s) if s > 0.0 => (raw as f64 * s).ceil() as i64,
                        _ => raw as i64,
                    };
                    let total_i = scaled + b.length_adjust.unwrap_or(0) as i64;
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
        // 跨模板去噪：多模板并行匹配同一路流时，同一段字节可能被某个模板判为坏帧，
        // 却被另一个模板完整解释成有效帧——那就不该再产生一条红色噪声行。
        // Modbus 尤其典型：主站读请求 [addr,03,起始,数量,CRC] 会被「读响应」模板
        // 当作 byteCount=0 的响应；两个方向共用功能码，结构上无法只靠帧头区分。
        // 同模板的更晚有效解同样算"更好解释"（错位后退一字节重扫留下的半帧即此类）。
        if rows.iter().any(|r| !r.valid) {
            let explained: Vec<(u64, u64)> = rows
                .iter()
                .filter(|r| r.valid)
                .map(|r| (r.seq, r.seq + r.len as u64))
                .collect();
            let before = rows.len();
            rows.retain(|r| {
                r.valid
                    || {
                        let (s, e) = (r.seq, r.seq + r.len as u64);
                        !explained.iter().any(|(vs, ve)| {
                            let ov = e.min(*ve).saturating_sub(s.max(*vs));
                            ov * 2 >= r.len as u64 // 重叠过半即视为"已被更好解释"
                        })
                    }
            });
            let gone = (before - rows.len()) as u64;
            *total = total.saturating_sub(gone);
            *errors = errors.saturating_sub(gone);
        }
        rows
    }
}

/// 帧缓冲的 `at` 处是否匹配模式 `val`（可按字节位掩码）。越界视为不匹配。
/// mask 缺省或短于 val 的位按 0xFF（精确匹配）；mask[i]==0x00 表示该字节通配。
fn byte_match(buf: &[u8], at: usize, val: &[u8], mask: Option<&[u8]>) -> bool {
    if val.is_empty() || at + val.len() > buf.len() {
        return false;
    }
    val.iter().enumerate().all(|(i, &p)| {
        let m = mask.and_then(|m| m.get(i).copied()).unwrap_or(0xFF);
        (buf[at + i] & m) == (p & m)
    })
}

/// 帧缓冲末尾是否正好是一个帧头。
fn tail_match(buf: &[u8], header: &[u8], mask: Option<&[u8]>) -> bool {
    buf.len() >= header.len() && byte_match(buf, buf.len() - header.len(), header, mask)
}

fn validate(tpl: &FrameTemplate) -> Result<(), String> {
    let b = &tpl.boundary;
    if b.header_bytes.len() > 8 {
        return Err(format!("模板[{}]帧头长度不能超过8字节", tpl.name));
    }
    if let Some(m) = b.header_mask.as_deref() {
        if m.len() > b.header_bytes.len() {
            return Err(format!("模板[{}]帧头掩码不应长于帧头", tpl.name));
        }
        // 掩码 0 = 该字节完全忽略；缺位按 0xFF
        if !b.header_bytes.is_empty()
            && b.header_bytes
                .iter()
                .enumerate()
                .all(|(i, _)| m.get(i).copied().unwrap_or(0xFF) == 0)
        {
            // 全通配帧头 = 无法定界（等同无帧头），显式拒绝，避免用户以为"设了帧头"
            return Err(format!(
                "模板[{}]帧头全部为通配（等同无帧头），请至少保留一个字节的确定值用于定帧",
                tpl.name
            ));
        }
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
        if f.offset >= 0 {
            if f.offset >= max_len as i64 {
                return Err(format!(
                    "模板[{}]字段[{}]偏移{}超出最大帧长",
                    tpl.name, f.name, f.offset
                ));
            }
        } else if -f.offset > max_len as i64 {
            return Err(format!(
                "模板[{}]字段[{}]负偏移{}超出最大帧长",
                tpl.name, f.name, -f.offset
            ));
        }
    }
    if let Some(ck) = &tpl.checksum {
        if ck.algo != "none" {
            if let Some(f) = tpl.fields.iter().find(|f| f.role == "checksum") {
                let fw = type_size(f);
                let aw = checksum_size(&ck.algo);
                if fw != aw {
                    return Err(format!(
                        "模板[{}]校验域占 {} B，但算法 {} 产出 {} B——请调整校验字段宽度或算法",
                        tpl.name, fw, ck.algo, aw
                    ));
                }
            }
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
        Some(f) => {
            if f.offset < 0 {
                let off = buf.len() as i64 + f.offset;
                if off < 0 {
                    return (false, Some("校验位置越界".into()));
                }
                off as usize
            } else if tpl.boundary.mode == "fixedLength" {
                f.offset as usize
            } else {
                let fb = if tpl.boundary.mode == "footer" {
                    tpl.boundary.footer_bytes.as_deref().map_or(0, |v| v.len())
                } else {
                    0
                };
                let off = buf.len() as i64 - size as i64 - fb as i64;
                if off < 0 {
                    return (false, Some("校验位置越界".into()));
                }
                off as usize
            }
        }
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

/// 字节序模式 → (基础序, 是否交换字序)。
/// 新增两档是为 Modbus 等「32 位量占两个 16 位寄存器」的协议：现场四种字序
/// ABCD(大端) / DCBA(小端) / CDAB(大端交换字) / BADC(小端交换字)，
/// 只给大小端时用户会遇到"数值离谱"的经典坑。
fn endian_parts(endian: &str) -> (bool, bool) {
    let swap = endian.ends_with("-word-swap");
    let big = if swap {
        endian.starts_with("big")
    } else {
        endian == "big"
    };
    (big, swap)
}

/// 把线上字节整理成大端序：需要交换字序时先按 16 位字倒序，再按基础序整理。
/// CDAB：字倒序后即为大端；BADC：字倒序后需再整体反转（=小端整理）。
/// 逐字段解码的热路径，故用栈上定长数组零分配（最多 8 字节）。
fn read_uint(bytes: &[u8], endian: &str) -> u64 {
    let (big, swap) = endian_parts(endian);
    let n = bytes.len().min(8);
    let mut c = [0u8; 8];
    if swap && n >= 4 && n % 2 == 0 {
        let mut i = 0;
        while i + 2 <= n {
            c[i] = bytes[n - 2 - i];
            c[i + 1] = bytes[n - 1 - i];
            i += 2;
        }
    } else {
        c[..n].copy_from_slice(&bytes[..n]);
    }
    if !big {
        c[..n].reverse();
    }
    let mut v: u64 = 0;
    for &b in &c[..n] {
        v = (v << 8) | b as u64;
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

/// 校验失败时"后退一字节重找帧头"的最大层数：错位点与真帧头之间可能隔着若干字节
/// （Modbus 主站请求里就常埋着假的 `[任意,03]` 锚点），层数太小仍会丢帧；
/// 每层至多重扫一帧长的字节且只在失败路径发生，成本有界。
const RESCAN_DEPTH: u32 = 12;

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
        if f.offset >= 0 && f.field_type == "csv" {
            let off = f.offset as usize;
            let delim = csv_delim_of(f);
            let rt = reserved_tail_len(tpl);
            let end = buf.len().saturating_sub(rt).max(off);
            if off < end {
                let sl = &buf[off..end];
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
        if f.offset >= 0 && f.span_tail.unwrap_or(false) && matches!(f.role.as_str(), "data" | "payload") {
            let off = f.offset as usize;
            let rt = reserved_tail_len(tpl);
            let end = buf.len().saturating_sub(rt).max(off);
            if off < end {
                let sl = &buf[off..end];
                let text = if f.field_type == "ascii" {
                    String::from_utf8_lossy(sl).to_string()
                } else {
                    sl.iter()
                        .map(|b| format!("{:02X}", b))
                        .collect::<Vec<_>>()
                        .join(" ")
                };
                out.push(FieldOut {
                    id: f.id.clone(),
                    name: f.name.clone(),
                    raw: 0.0,
                    value: 0.0,
                    text: Some(text),
                });
                if let Some(elem) = f.span_elem.as_deref() {
                    let esize = span_elem_size(elem);
                    if esize > 0 {
                        let scale = f.scale.unwrap_or(1.0);
                        let offv = f.offset_value.unwrap_or(0.0);
                        let mut i: usize = 0;
                        while off + (i + 1) * esize <= end && i < CSV_MAX_CH {
                            let s2 = &buf[off + i * esize..off + (i + 1) * esize];
                            let raw = decode_span_elem(elem, s2, &f.endian);
                            out.push(FieldOut {
                                id: format!("{}#{}", f.id, i + 1),
                                name: format!("{}{}", f.name, i + 1),
                                raw,
                                value: raw * scale + offv,
                                text: None,
                            });
                            i += 1;
                        }
                    }
                }
            }
            continue;
        }
        let size = type_size(f);
        let start = if f.offset < 0 {
            let s = buf.len() as i64 + f.offset;
            if s < 0 {
                continue;
            }
            s as usize
        } else {
            f.offset as usize
        };
        if start + size > buf.len() {
            continue;
        }
        let sl = &buf[start..start + size];
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

fn span_elem_size(elem: &str) -> usize {
    match elem {
        "uint8" | "int8" => 1,
        "uint16" | "int16" => 2,
        "uint32" | "int32" | "float32" => 4,
        "float64" => 8,
        _ => 0,
    }
}

fn decode_span_elem(elem: &str, sl: &[u8], endian: &str) -> f64 {
    match elem {
        "uint8" => sl[0] as f64,
        "int8" => sl[0] as i8 as f64,
        "uint16" | "uint32" => read_uint(sl, endian) as f64,
        "int16" => (read_uint(sl, endian) as u16) as i16 as f64,
        "int32" => (read_uint(sl, endian) as u32) as i32 as f64,
        "float32" => f32::from_bits(read_uint(sl, endian) as u32) as f64,
        "float64" => f64::from_bits(read_uint(sl, endian)),
        _ => 0.0,
    }
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
                        ..Default::default()
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
                        ..Default::default()
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
        offset: i64,
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
            span_tail: None,
            span_elem: None,
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
                ..Default::default()
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
                span_tail: None,
                span_elem: None,
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
            span_tail: None,
            span_elem: None,
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
            span_tail: None,
            span_elem: None,
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
                    ..Default::default()
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
                    span_tail: None,
                    span_elem: None,
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
                    ..Default::default()
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
                    span_tail: None,
                    span_elem: None,
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
                ..Default::default()
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
                span_tail: None,
                span_elem: None,
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
                    ..Default::default()
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
                    span_tail: None,
                    span_elem: None,
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

    fn span_tail_length_rules() -> FrameTemplate {
        let mut pld = field("s-pld", "载荷", "payload", 3, "uint8", "little");
        pld.span_tail = Some(true);
        FrameTemplate {
            id: "s".into(),
            name: "变长帧".into(),
            color: "#3fb950".into(),
            enabled: true,
            boundary: Boundary {
                mode: "lengthField".into(),
                header_bytes: vec![0xAA, 0x55],
                fixed_length: None,
                length_offset: Some(2),
                length_size: Some(1),
                length_endian: Some("little".into()),
                length_adjust: Some(0),
                footer_bytes: None,
                max_length: Some(64),
                disc_offset: None,
                disc_value: None,
                discs: Vec::new(),
                ..Default::default()
            },
            checksum: Some(ChecksumCfg {
                algo: "sum8".into(),
                coverage_start: 0,
                coverage_end: -1,
                endian: "little".into(),
            }),
            fields: vec![
                field("s-len", "长度", "length", 2, "uint8", "little"),
                pld,
            ],
        }
    }

    fn build_span_frame(payload: &[u8]) -> Vec<u8> {
        let mut f = vec![0xAA, 0x55, (payload.len() + 4) as u8];
        f.extend_from_slice(payload);
        let sum = f.iter().fold(0u8, |acc, &b| acc.wrapping_add(b));
        f.push(sum);
        f
    }

    #[test]
    fn span_tail_payload_adapts_to_length_field() {
        let mut eng = ParserEngine::new();
        eng.set_rules(ParseRules {
            templates: vec![span_tail_length_rules()],
        })
        .unwrap();
        let mut stream = build_span_frame(&[0x11, 0x22, 0x33, 0x44]);
        stream.extend_from_slice(&build_span_frame(&[0x55, 0x66]));
        let rows = eng.feed(&stream, 0, 100);
        assert_eq!(rows.len(), 2, "两种长度都应成帧: {rows:?}");
        assert!(rows.iter().all(|r| r.valid), "校验应通过: {rows:?}");
        assert_eq!(rows[0].len, 8);
        assert_eq!(rows[1].len, 6);
        let txt = |r: &FrameRow| {
            r.fields
                .iter()
                .find(|f| f.id == "s-pld")
                .map(|f| f.text.clone().unwrap_or_default())
        };
        assert_eq!(txt(&rows[0]), Some("11 22 33 44".into()));
        assert_eq!(txt(&rows[1]), Some("55 66".into()));
        let lenv = |r: &FrameRow| {
            r.fields
                .iter()
                .find(|f| f.id == "s-len")
                .map(|f| f.raw)
        };
        assert_eq!(lenv(&rows[0]), Some(8.0));
        assert_eq!(lenv(&rows[1]), Some(6.0));
    }

    #[test]
    fn span_tail_footer_ascii_text() {
        let mut tpl = span_tail_length_rules();
        tpl.id = "t".into();
        tpl.boundary = Boundary {
            mode: "footer".into(),
            header_bytes: Vec::new(),
            fixed_length: None,
            length_offset: None,
            length_size: None,
            length_endian: None,
            length_adjust: None,
            footer_bytes: Some(vec![0x0A]),
            max_length: Some(64),
            disc_offset: None,
            disc_value: None,
            discs: Vec::new(),
            ..Default::default()
        };
        tpl.checksum = None;
        tpl.fields = vec![{
            let mut a = field("s-txt", "文本", "payload", 0, "ascii", "little");
            a.span_tail = Some(true);
            a
        }];
        let mut eng = ParserEngine::new();
        eng.set_rules(ParseRules { templates: vec![tpl] }).unwrap();
        let mut stream: Vec<u8> = b"1,2,3\n".to_vec();
        stream.extend_from_slice(b"hello\n");
        let rows = eng.feed(&stream, 0, 100);
        assert_eq!(rows.len(), 2, "帧尾模式两帧: {rows:?}");
        assert!(rows.iter().all(|r| r.valid));
        let txt = |r: &FrameRow| {
            r.fields
                .iter()
                .find(|f| f.id == "s-txt")
                .map(|f| f.text.clone().unwrap_or_default())
        };
        assert_eq!(txt(&rows[0]), Some("1,2,3".into()));
        assert_eq!(txt(&rows[1]), Some("hello".into()));
    }

    #[test]
    fn span_tail_element_sequence() {
        let mut tpl = span_tail_length_rules();
        let mut pld = field("s-pld", "温度", "payload", 3, "uint8", "little");
        pld.span_tail = Some(true);
        pld.span_elem = Some("float32".into());
        pld.scale = Some(0.5);
        tpl.fields = vec![field("s-len", "长度", "length", 2, "uint8", "little"), pld];
        let mut eng = ParserEngine::new();
        eng.set_rules(ParseRules { templates: vec![tpl] }).unwrap();

        let mut p1 = Vec::new();
        p1.extend_from_slice(&1.5f32.to_le_bytes());
        p1.extend_from_slice(&(-2.25f32).to_le_bytes());
        p1.extend_from_slice(&100.0f32.to_le_bytes());
        let mut stream = build_span_frame(&p1);
        stream.extend_from_slice(&build_span_frame(&3.0f32.to_le_bytes()));
        let rows = eng.feed(&stream, 0, 100);
        assert_eq!(rows.len(), 2, "两帧都应成帧: {rows:?}");
        assert!(rows.iter().all(|r| r.valid));
        assert_eq!(rows[0].len, 16);
        assert_eq!(rows[1].len, 8);

        let ch = |r: &FrameRow, k: &str| {
            r.fields.iter().find(|f| f.id == k).map(|f| f.value)
        };
        assert_eq!(ch(&rows[0], "s-pld#1"), Some(0.75));
        assert_eq!(ch(&rows[0], "s-pld#2"), Some(-1.125));
        assert_eq!(ch(&rows[0], "s-pld#3"), Some(50.0));
        assert!(rows[0].fields.iter().find(|f| f.id == "s-pld#4").is_none());
        assert!(rows[0]
            .fields
            .iter()
            .find(|f| f.id == "s-pld")
            .and_then(|f| f.text.as_deref())
            .is_some(), "父文本输出应保留");
        assert_eq!(ch(&rows[1], "s-pld#1"), Some(1.5));
        assert!(rows[1].fields.iter().find(|f| f.id == "s-pld#2").is_none());
    }

    fn ck_template(ck_type: &str) -> FrameTemplate {
        FrameTemplate {
            id: "ck".into(),
            name: "校验帧".into(),
            color: "#3fb950".into(),
            enabled: true,
            boundary: Boundary {
                mode: "fixedLength".into(),
                header_bytes: Vec::new(),
                fixed_length: Some(2),
                length_offset: None,
                length_size: None,
                length_endian: None,
                length_adjust: None,
                footer_bytes: None,
                max_length: Some(64),
                disc_offset: None,
                disc_value: None,
                discs: Vec::new(),
                ..Default::default()
            },
            checksum: Some(ChecksumCfg {
                algo: "sum8".into(),
                coverage_start: 0,
                coverage_end: -1,
                endian: "little".into(),
            }),
            fields: vec![field("ck1", "和校验", "checksum", 0, ck_type, "little")],
        }
    }

    #[test]
    fn checksum_field_width_must_match_algo() {
        let mut eng = ParserEngine::new();
        assert!(eng.set_rules(ParseRules { templates: vec![ck_template("uint8")] }).is_ok());
        let err = eng
            .set_rules(ParseRules {
                templates: vec![ck_template("uint16")],
            })
            .unwrap_err();
        assert!(err.contains("校验域占"), "应报出宽度一致性错误: {err}");
        let rows = eng.feed(&[0x10, 0x10], 0, 1);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].valid, "sum8(0x10)=0x10 应通过");
    }

    #[test]
    fn variable_mode_checksum_anchors_to_tail() {
        let mut tpl = span_tail_length_rules();
        let mut ck = field("s-ck", "和校验", "checksum", 3, "uint8", "little");
        ck.span_tail = None;
        tpl.fields.push(ck);
        let mut eng = ParserEngine::new();
        eng.set_rules(ParseRules { templates: vec![tpl] }).unwrap();

        let frame = build_span_frame(&[0x11, 0x22, 0x33]);
        let rows = eng.feed(&frame, 0, 100);
        assert_eq!(rows.len(), 1);
        assert!(
            rows[0].valid,
            "尾字节=sum 应通过，即使 CK 字段偏移(3)在帧中间: {rows:?}"
        );

        let mut bad = build_span_frame(&[0x11, 0x22, 0x33]);
        let n = bad.len();
        bad[n - 1] ^= 0xFF;
        let rows = eng.feed(&bad, 0, 100);
        assert_eq!(rows.len(), 1);
        assert!(!rows[0].valid, "尾字节被篡改应失败");
    }

    #[test]
    fn negative_offset_field_anchors_to_tail() {
        let mut tpl = span_tail_length_rules();
        let mut st = field("s-st", "状态", "data", -2, "uint8", "little");
        st.span_tail = None;
        tpl.fields.push(st);
        let mut eng = ParserEngine::new();
        eng.set_rules(ParseRules { templates: vec![tpl] }).unwrap();

        let build = |payload: &[u8], status: u8| -> Vec<u8> {
            let mut f = vec![0xAA, 0x55, (payload.len() + 5) as u8];
            f.extend_from_slice(payload);
            f.push(status);
            let sum = f.iter().fold(0u8, |acc, &b| acc.wrapping_add(b));
            f.push(sum);
            f
        };
        let mut stream = build(&[0x11, 0x22, 0x33], 0x5A);
        stream.extend_from_slice(&build(&[0x44], 0x2C));
        let rows = eng.feed(&stream, 0, 100);
        assert_eq!(rows.len(), 2, "两种长度都应成帧: {rows:?}");
        assert!(rows.iter().all(|r| r.valid), "状态+和校验都应通过: {rows:?}");
        let stv = |r: &FrameRow| {
            r.fields.iter().find(|f| f.id == "s-st").map(|f| f.raw)
        };
        assert_eq!(stv(&rows[0]), Some(0x5A as f64), "状态应取自帧尾前1字节");
        assert_eq!(stv(&rows[1]), Some(0x2C as f64), "短帧状态应随帧长自适应");
    }

    /* ---------------- M1：Modbus 所需的引擎表达力 ---------------- */

    /// 构造一条 Modbus RTU 读保持寄存器响应：[addr][0x03][byteCount][regs...][CRC16 小端]
    fn rtu_read_resp(addr: u8, regs: &[u16]) -> Vec<u8> {
        let mut f = vec![addr, 0x03, (regs.len() * 2) as u8];
        for r in regs {
            f.extend_from_slice(&r.to_be_bytes());
        }
        let crc = crc16_modbus(&f);
        f.extend_from_slice(&crc.to_le_bytes());
        f
    }

    /// 帧头掩码模板：[任意从站地址][FC 0x03]，长度域=字节数+5，寄存器为跨帧尾数组
    fn masked_rtu_tpl() -> FrameTemplate {
        let mut regs = field("regs", "寄存器", "data", 3, "uint16", "big");
        regs.span_tail = Some(true);
        regs.span_elem = Some("uint16".into());
        FrameTemplate {
            id: "mb3".into(),
            name: "读保持寄存器响应".into(),
            color: "#bc8cff".into(),
            enabled: true,
            boundary: Boundary {
                mode: "lengthField".into(),
                header_bytes: vec![0x00, 0x03],
                header_mask: Some(vec![0x00, 0xFF]),
                length_offset: Some(2),
                length_size: Some(1),
                length_endian: Some("big".into()),
                length_adjust: Some(5),
                max_length: Some(280),
                ..Default::default()
            },
            checksum: Some(ChecksumCfg {
                algo: "crc16_modbus".into(),
                coverage_start: 0,
                coverage_end: -2,
                endian: "little".into(),
            }),
            fields: vec![field("addr", "设备地址", "id", 0, "uint8", "big"), regs],
        }
    }

    #[test]
    fn header_mask_matches_any_slave_address() {
        let mut eng = ParserEngine::new();
        eng.set_rules(ParseRules {
            templates: vec![masked_rtu_tpl()],
        })
        .unwrap();

        // 总线上三个不同从站（含广播地址 0）都应被同一模板解析
        let mut stream = vec![0xFF, 0x00]; // 垃圾前导
        stream.extend(rtu_read_resp(0x01, &[0x1234, 0x5678]));
        stream.extend(rtu_read_resp(0x07, &[0x000A]));
        stream.extend(rtu_read_resp(0x00, &[0xFFFF]));
        let rows = eng.feed(&stream, 0, 100);

        let ok: Vec<&FrameRow> = rows.iter().filter(|r| r.valid).collect();
        assert_eq!(ok.len(), 3, "三个从站地址都应匹配: {rows:?}");
        assert_eq!(ok[0].fields.iter().find(|f| f.id == "addr").unwrap().raw, 1.0);
        assert_eq!(ok[1].fields.iter().find(|f| f.id == "addr").unwrap().raw, 7.0);
        // 寄存器数组：每条帧展开为 寄存器1..N
        let r2: Vec<f64> = ok[0]
            .fields
            .iter()
            .filter(|f| f.id.starts_with("regs#"))
            .map(|f| f.raw)
            .collect();
        assert_eq!(r2, vec![0x1234 as f64, 0x5678 as f64], "寄存器数组应按大端解出");
        assert_eq!(
            ok[2]
                .fields
                .iter()
                .find(|f| f.id == "regs#1")
                .unwrap()
                .raw,
            0xFFFF as f64
        );
    }

    #[test]
    fn header_mask_still_rejects_other_function_codes() {
        let mut eng = ParserEngine::new();
        eng.set_rules(ParseRules {
            templates: vec![masked_rtu_tpl()],
        })
        .unwrap();
        // FC=0x04 不是本模板的 0x03：帧头第二字节被掩码为精确匹配，应不成立帧
        let mut f = vec![0x01, 0x04, 0x02, 0x11, 0x22];
        let crc = crc16_modbus(&f);
        f.extend_from_slice(&crc.to_le_bytes());
        let rows = eng.feed(&f, 0, 100);
        assert!(
            rows.iter().all(|r| r.tpl_id != "mb3"),
            "FC 不匹配时不得误成帧: {rows:?}"
        );
    }

    /// FC01/02 响应的长度域是「位数」：总长 = ceil(位数/8) + 5
    #[test]
    fn length_scale_converts_bit_count_to_bytes() {
        let mut tpl = masked_rtu_tpl();
        tpl.boundary.header_bytes = vec![0x00, 0x01];
        tpl.boundary.length_scale = Some(0.125);
        let mut eng = ParserEngine::new();
        eng.set_rules(ParseRules {
            templates: vec![tpl],
        })
        .unwrap();

        // 12 个线圈 → ceil(12/8)=2 字节数据 → 总长 3+2+2=7
        let mut f = vec![0x05, 0x01, 12u8, 0b10110101, 0b00001011];
        let crc = crc16_modbus(&f);
        f.extend_from_slice(&crc.to_le_bytes());
        let rows = eng.feed(&f, 0, 100);
        assert_eq!(rows.len(), 1, "位数应换算成字节数完成定帧: {rows:?}");
        assert!(rows[0].valid, "CRC 应通过: {rows:?}");
        assert_eq!(rows[0].len, 7);
    }

    /// 异常响应：帧头用「bit7=1」掩码锚定 → 一条模板吃下任意功能码的异常
    #[test]
    fn header_bit_mask_matches_any_exception_response() {
        let mut eng = ParserEngine::new();
        eng.set_rules(ParseRules {
            templates: vec![exception_tpl()],
        })
        .unwrap();

        let mk = |fc: u8, code: u8| -> Vec<u8> {
            let mut f = vec![0x03, fc, code];
            let crc = crc16_modbus(&f);
            f.extend_from_slice(&crc.to_le_bytes());
            f
        };
        let mut stream = mk(0x83, 0x02); // 读保持寄存器异常
        stream.extend(mk(0x90, 0x04)); // 其他功能码异常
        stream.extend(mk(0x03, 0x02)); // 正常响应 → 不应命中异常模板
        let rows = eng.feed(&stream, 0, 100);
        let hit: Vec<&FrameRow> = rows.iter().filter(|r| r.valid).collect();
        assert_eq!(hit.len(), 2, "只应命中两条异常帧: {rows:?}");
        assert_eq!(hit[0].fields[0].raw, 2.0, "异常码 02");
        assert_eq!(hit[1].fields[0].raw, 4.0, "异常码 04");
    }

    fn exception_tpl() -> FrameTemplate {
        FrameTemplate {
            id: "mbex".into(),
            name: "异常响应".into(),
            color: "#e5534b".into(),
            enabled: true,
            boundary: Boundary {
                mode: "fixedLength".into(),
                // 首字节=任意从站；次字节按位掩码要求 bit7=1（= 异常响应 FC）
                header_bytes: vec![0x00, 0x80],
                header_mask: Some(vec![0x00, 0x80]),
                fixed_length: Some(5),
                max_length: Some(64),
                ..Default::default()
            },
            checksum: Some(ChecksumCfg {
                algo: "crc16_modbus".into(),
                coverage_start: 0,
                coverage_end: -2,
                endian: "little".into(),
            }),
            fields: vec![field("ecode", "异常码", "data", 2, "uint8", "big")],
        }
    }

    /// 识别位（discs）同样支持按位掩码：帧首精确 + FC 只要求 bit7
    #[test]
    fn disc_bit_mask_narrows_without_enumerating_values() {
        let mut tpl = exception_tpl();
        tpl.id = "mbex2".into();
        tpl.boundary.header_bytes = vec![0x03]; // 只看 3 号从站
        tpl.boundary.header_mask = Some(vec![0xFF]);
        tpl.boundary.fixed_length = None;
        tpl.boundary.mode = "lengthField".into();
        tpl.boundary.length_offset = Some(2);
        tpl.boundary.length_size = Some(1);
        tpl.boundary.length_adjust = Some(4);
        tpl.boundary.discs = vec![DiscCfg {
            offset: 1,
            value: vec![0x80],
            mask: Some(vec![0x80]),
        }];
        // 异常帧数据域长度恒为 1：总长 = 1 + 4 = 5
        let mut eng = ParserEngine::new();
        eng.set_rules(ParseRules {
            templates: vec![tpl],
        })
        .unwrap();
        let mk = |addr: u8, fc: u8, code: u8| -> Vec<u8> {
            let mut f = vec![addr, fc, code];
            let crc = crc16_modbus(&f);
            f.extend_from_slice(&crc.to_le_bytes());
            f
        };
        let mut stream = mk(0x03, 0x86, 0x01); // 3 号从站异常 → 命中
        stream.extend(mk(0x04, 0x86, 0x01)); // 4 号从站 → 帧首精确，不命中
        stream.extend(mk(0x03, 0x06, 0x01)); // 正常写回显 → 识别位不命中
        let rows = eng.feed(&stream, 0, 100);
        let hit: Vec<&FrameRow> = rows.iter().filter(|r| r.valid).collect();
        assert_eq!(hit.len(), 1, "只有 3 号从站的异常帧应命中: {rows:?}");
        assert_eq!(hit[0].tpl_id, "mbex2");
    }

    /// 真实轮询流（主站请求 + 从站响应交替、地址与寄存器数都在变）：
    /// 两个方向的模板同时启用，必须逐帧对齐、且不得产生任何噪声坏帧行
    #[test]
    fn rtu_poll_stream_stays_aligned() {
        let mut req = masked_rtu_tpl();
        req.id = "mbq".into();
        req.name = "读请求".into();
        req.boundary.mode = "fixedLength".into();
        req.boundary.fixed_length = Some(8);
        req.boundary.length_offset = None;
        req.boundary.length_size = None;
        req.boundary.length_endian = None;
        req.boundary.length_adjust = None;
        req.fields = vec![field("qty", "数量", "data", 4, "uint16", "big")];

        let mut eng = ParserEngine::new();
        eng.set_rules(ParseRules {
            templates: vec![masked_rtu_tpl(), req],
        })
        .unwrap();

        let rounds = 30usize;
        let mut stream = Vec::new();
        let mut expect: Vec<(u8, Vec<u16>)> = Vec::new();
        for i in 0..rounds {
            let addr = (i % 5 + 1) as u8;
            let regs: Vec<u16> = (0..(i % 4) as u16).map(|k| k * 0x111 + i as u16).collect();
            let mut q = vec![addr, 0x03, 0x00, 0x00, 0x00, regs.len() as u8];
            let qc = crc16_modbus(&q);
            q.extend_from_slice(&qc.to_le_bytes());
            stream.extend(q);
            stream.extend(rtu_read_resp(addr, &regs));
            expect.push((addr, regs));
        }
        let rows = eng.feed(&stream, 0, 100);

        assert!(
            rows.iter().all(|r| r.valid),
            "同一段字节已被另一模板完整解释时不应留下坏帧行（坏帧 {} 条）: {:?}",
            rows.iter().filter(|r| !r.valid).count(),
            rows.iter()
                .filter(|r| !r.valid)
                .map(|r| (r.tpl_id.as_str(), r.seq, r.len))
                .collect::<Vec<_>>()
        );
        let resp: Vec<&FrameRow> = rows.iter().filter(|r| r.tpl_id == "mb3").collect();
        let reqs: Vec<&FrameRow> = rows.iter().filter(|r| r.tpl_id == "mbq").collect();
        assert_eq!(resp.len(), rounds, "每轮响应都应恰好一帧");
        assert_eq!(reqs.len(), rounds, "每轮请求都应恰好一帧");
        for (i, r) in resp.iter().enumerate() {
            let got: Vec<f64> = r
                .fields
                .iter()
                .filter(|f| f.id.starts_with("regs#"))
                .map(|f| f.raw)
                .collect();
            let want: Vec<f64> = expect[i].1.iter().map(|v| *v as f64).collect();
            assert_eq!(got, want, "第 {i} 轮寄存器值不匹配");
            assert_eq!(
                r.fields.iter().find(|f| f.id == "addr").unwrap().raw,
                expect[i].0 as f64,
                "第 {i} 轮从站地址不匹配"
            );
        }
    }

    /// 32 位量的四种现场字序（Modbus 两个寄存器拼一个 32 位值）
    #[test]
    fn thirtytwo_bit_word_orders() {
        // 线上字节 [12 34 56 78]，按四种字序解释
        let raw = [0x12u8, 0x34, 0x56, 0x78];
        assert_eq!(read_uint(&raw, "big"), 0x1234_5678, "ABCD=大端");
        assert_eq!(read_uint(&raw, "little"), 0x7856_3412, "DCBA=小端");
        assert_eq!(read_uint(&raw, "big-word-swap"), 0x5678_1234, "CDAB");
        assert_eq!(read_uint(&raw, "little-word-swap"), 0x3412_7856, "BADC");

        // 反向自洽：设备以 CDAB 送出 0x12345678，解码应还原
        let wire = [0x56u8, 0x78, 0x12, 0x34];
        assert_eq!(read_uint(&wire, "big-word-swap"), 0x1234_5678);
        let wire2 = [0x34u8, 0x12, 0x78, 0x56];
        assert_eq!(read_uint(&wire2, "little-word-swap"), 0x1234_5678);

        // 16 位不受字序交换影响（无字可换）
        let w16 = [0xABu8, 0xCD];
        assert_eq!(read_uint(&w16, "big-word-swap"), read_uint(&w16, "big"));
        assert_eq!(read_uint(&w16, "little-word-swap"), read_uint(&w16, "little"));
    }

    /// 重同步不得吞帧：帧头跨两次 feed 边界到达时仍要成帧
    #[test]
    fn resync_does_not_swallow_header_across_chunks() {
        let mut eng = ParserEngine::new();
        eng.set_rules(ParseRules {
            templates: vec![masked_rtu_tpl()],
        })
        .unwrap();
        let f1 = rtu_read_resp(0x02, &[0x0102]);
        let f2 = rtu_read_resp(0x09, &[0x0304, 0x0506]);
        // 逐块喂入：垃圾尾、半帧头、剩余部分、整帧……任意切分都必须解析出 2 帧
        let mut rows = Vec::new();
        rows.extend(eng.feed(&[0x77, f2[0]], 0, 1));
        rows.extend(eng.feed(&f2[1..3], 1, 2));
        rows.extend(eng.feed(&f2[3..], 3, 3));
        rows.extend(eng.feed(&f1, 5, 4));
        let ok: Vec<&FrameRow> = rows.iter().filter(|r| r.valid).collect();
        assert_eq!(ok.len(), 2, "任意分块都不应丢帧: {rows:?}");
    }
}
