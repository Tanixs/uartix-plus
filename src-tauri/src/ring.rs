use std::collections::VecDeque;

pub struct RingBuffer {
    data: Vec<u8>,
    head: usize,
    total: u64,
    filled: usize,
    ts_ring: VecDeque<(u64, u64)>,
}

impl RingBuffer {
    pub fn new(cap: usize) -> Self {
        Self {
            data: vec![0u8; cap],
            head: 0,
            total: 0,
            filled: 0,
            ts_ring: VecDeque::new(),
        }
    }

    pub fn total(&self) -> u64 {
        self.total
    }

    pub fn start_seq(&self) -> u64 {
        self.total - self.filled as u64
    }

    pub fn append(&mut self, bytes: &[u8], ts: u64) {
        if bytes.is_empty() {
            return;
        }
        let cap = self.data.len();
        let mut pos = self.head;
        let mut rem = bytes;
        while !rem.is_empty() {
            let first = rem.len().min(cap - pos);
            self.data[pos..pos + first].copy_from_slice(&rem[..first]);
            pos = (pos + first) % cap;
            rem = &rem[first..];
        }
        self.head = pos;
        self.total += bytes.len() as u64;
        self.filled = (self.filled + bytes.len()).min(cap);
        self.ts_ring.push_back((self.total, ts));
        while self.ts_ring.len() > 8192 {
            self.ts_ring.pop_front();
        }
    }

    pub fn fetch(&self, start: u64, end: u64) -> (u64, Vec<u8>) {
        let s = start.max(self.start_seq()).min(self.total);
        let e = end.max(s).min(self.total);
        let n = (e - s) as usize;
        if n == 0 {
            return (s, Vec::new());
        }
        let cap = self.data.len();
        let sidx = (s as usize) % cap;
        let mut out = vec![0u8; n];
        let first = n.min(cap - sidx);
        out[..first].copy_from_slice(&self.data[sidx..sidx + first]);
        if n > first {
            out[first..].copy_from_slice(&self.data[..n - first]);
        }
        (s, out)
    }

    pub fn ts_at(&self, seq: u64) -> u64 {
        for &(end, ts) in &self.ts_ring {
            if end > seq {
                return ts;
            }
        }
        0
    }
}
