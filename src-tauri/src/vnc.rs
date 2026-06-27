//! VNC (RFB 3.8) protocol codec — pure, unit-tested wire-format parsers/encoders.
//!
//! This is the verifiable foundation of the remote-desktop feature (B1): the RFB
//! message formats a VNC client must encode/decode. The async connection loop,
//! the frontend canvas renderer, input mapping, and VNC-auth DES are layered on
//! top of these primitives (and need a live VNC server to verify end-to-end).
//! RDP (via ironrdp) is a separate, heavier track.
//!
//! All multi-byte fields are big-endian per RFC 6143.

#![allow(dead_code)]

/// 8-bit/component pixel layout from ServerInit (RFC 6143 §7.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PixelFormat {
    pub bits_per_pixel: u8,
    pub depth: u8,
    pub big_endian: bool,
    pub true_color: bool,
    pub red_max: u16,
    pub green_max: u16,
    pub blue_max: u16,
    pub red_shift: u8,
    pub green_shift: u8,
    pub blue_shift: u8,
}

/// ServerInit message (RFC 6143 §7.3.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerInit {
    pub width: u16,
    pub height: u16,
    pub pixel_format: PixelFormat,
    pub name: String,
}

/// A framebuffer-update rectangle header (RFC 6143 §7.6.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RectHeader {
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
    pub encoding: i32,
}

/// Parse the 12-byte ProtocolVersion handshake (e.g. "RFB 003.008\n") → (major, minor).
pub fn parse_protocol_version(buf: &[u8]) -> Option<(u8, u8)> {
    if buf.len() != 12 || &buf[0..4] != b"RFB " || buf[11] != b'\n' {
        return None;
    }
    let s = std::str::from_utf8(&buf[4..11]).ok()?; // "003.008"
    let (maj, min) = s.split_once('.')?;
    Some((maj.parse().ok()?, min.parse().ok()?))
}

/// Encode a ProtocolVersion handshake line.
pub fn encode_protocol_version(major: u8, minor: u8) -> [u8; 12] {
    let s = format!("RFB {:03}.{:03}\n", major, minor);
    let b = s.as_bytes();
    let mut out = [0u8; 12];
    out.copy_from_slice(&b[..12]);
    out
}

/// Parse the 16-byte PixelFormat block.
pub fn parse_pixel_format(b: &[u8]) -> Option<PixelFormat> {
    if b.len() < 16 {
        return None;
    }
    Some(PixelFormat {
        bits_per_pixel: b[0],
        depth: b[1],
        big_endian: b[2] != 0,
        true_color: b[3] != 0,
        red_max: u16::from_be_bytes([b[4], b[5]]),
        green_max: u16::from_be_bytes([b[6], b[7]]),
        blue_max: u16::from_be_bytes([b[8], b[9]]),
        red_shift: b[10],
        green_shift: b[11],
        blue_shift: b[12],
        // b[13..16] padding
    })
}

/// Parse a ServerInit message: 2+2 size, 16 pixel-format, 4 name-length, name bytes.
pub fn parse_server_init(b: &[u8]) -> Option<ServerInit> {
    if b.len() < 24 {
        return None;
    }
    let width = u16::from_be_bytes([b[0], b[1]]);
    let height = u16::from_be_bytes([b[2], b[3]]);
    let pixel_format = parse_pixel_format(&b[4..20])?;
    let name_len = u32::from_be_bytes([b[20], b[21], b[22], b[23]]) as usize;
    if b.len() < 24 + name_len {
        return None;
    }
    let name = String::from_utf8_lossy(&b[24..24 + name_len]).into_owned();
    Some(ServerInit { width, height, pixel_format, name })
}

/// Parse a 12-byte framebuffer-update rectangle header.
pub fn parse_rect_header(b: &[u8]) -> Option<RectHeader> {
    if b.len() < 12 {
        return None;
    }
    Some(RectHeader {
        x: u16::from_be_bytes([b[0], b[1]]),
        y: u16::from_be_bytes([b[2], b[3]]),
        width: u16::from_be_bytes([b[4], b[5]]),
        height: u16::from_be_bytes([b[6], b[7]]),
        encoding: i32::from_be_bytes([b[8], b[9], b[10], b[11]]),
    })
}

/// Encode a FramebufferUpdateRequest (client msg type 3).
pub fn encode_fb_update_request(incremental: bool, x: u16, y: u16, w: u16, h: u16) -> [u8; 10] {
    let mut out = [0u8; 10];
    out[0] = 3;
    out[1] = incremental as u8;
    out[2..4].copy_from_slice(&x.to_be_bytes());
    out[4..6].copy_from_slice(&y.to_be_bytes());
    out[6..8].copy_from_slice(&w.to_be_bytes());
    out[8..10].copy_from_slice(&h.to_be_bytes());
    out
}

/// Encode a PointerEvent (client msg type 5): button mask + position.
pub fn encode_pointer_event(button_mask: u8, x: u16, y: u16) -> [u8; 6] {
    let mut out = [0u8; 6];
    out[0] = 5;
    out[1] = button_mask;
    out[2..4].copy_from_slice(&x.to_be_bytes());
    out[4..6].copy_from_slice(&y.to_be_bytes());
    out
}

/// Encode a KeyEvent (client msg type 4): down flag + X11 keysym.
pub fn encode_key_event(down: bool, keysym: u32) -> [u8; 8] {
    let mut out = [0u8; 8];
    out[0] = 4;
    out[1] = down as u8;
    // out[2..4] padding
    out[4..8].copy_from_slice(&keysym.to_be_bytes());
    out
}

/// Prepare the VNC-auth DES key from a password: take up to 8 bytes (NUL-padded)
/// and bit-reverse each byte — the quirk of the VNC authentication scheme
/// (RFC 6143 §7.2.2 references the DES variant where each key byte's bits are mirrored).
pub fn vnc_des_key(password: &str) -> [u8; 8] {
    let pw = password.as_bytes();
    let mut key = [0u8; 8];
    for i in 0..8 {
        let byte = if i < pw.len() { pw[i] } else { 0 };
        key[i] = byte.reverse_bits();
    }
    key
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_version_round_trips() {
        let enc = encode_protocol_version(3, 8);
        assert_eq!(&enc, b"RFB 003.008\n");
        assert_eq!(parse_protocol_version(&enc), Some((3, 8)));
        assert_eq!(parse_protocol_version(b"RFB 003.003\n"), Some((3, 3)));
    }

    #[test]
    fn protocol_version_rejects_garbage() {
        assert_eq!(parse_protocol_version(b"NOPE 03.008\n"), None);
        assert_eq!(parse_protocol_version(b"too short"), None);
        assert_eq!(parse_protocol_version(b"RFB 003.008X"), None); // no trailing \n
    }

    #[test]
    fn parses_server_init_with_name() {
        // 800x600, a typical 32bpp true-color BGRA pixel format, name "qemu".
        let mut b = Vec::new();
        b.extend_from_slice(&800u16.to_be_bytes());
        b.extend_from_slice(&600u16.to_be_bytes());
        b.extend_from_slice(&[32, 24, 0, 1]); // bpp, depth, big-endian=0, true-color=1
        b.extend_from_slice(&255u16.to_be_bytes()); // red max
        b.extend_from_slice(&255u16.to_be_bytes()); // green max
        b.extend_from_slice(&255u16.to_be_bytes()); // blue max
        b.extend_from_slice(&[16, 8, 0]); // red/green/blue shift
        b.extend_from_slice(&[0, 0, 0]); // padding
        b.extend_from_slice(&4u32.to_be_bytes()); // name length
        b.extend_from_slice(b"qemu");

        let si = parse_server_init(&b).expect("parse");
        assert_eq!(si.width, 800);
        assert_eq!(si.height, 600);
        assert_eq!(si.name, "qemu");
        assert_eq!(si.pixel_format.bits_per_pixel, 32);
        assert_eq!(si.pixel_format.depth, 24);
        assert!(si.pixel_format.true_color);
        assert!(!si.pixel_format.big_endian);
        assert_eq!(si.pixel_format.red_shift, 16);
        assert_eq!(si.pixel_format.blue_shift, 0);
    }

    #[test]
    fn server_init_rejects_truncated_name() {
        let mut b = vec![0u8; 24];
        b[20..24].copy_from_slice(&100u32.to_be_bytes()); // claims 100-byte name, none present
        assert_eq!(parse_server_init(&b), None);
    }

    #[test]
    fn parses_rect_header() {
        let mut b = Vec::new();
        b.extend_from_slice(&10u16.to_be_bytes());
        b.extend_from_slice(&20u16.to_be_bytes());
        b.extend_from_slice(&64u16.to_be_bytes());
        b.extend_from_slice(&48u16.to_be_bytes());
        b.extend_from_slice(&0i32.to_be_bytes()); // Raw encoding
        let r = parse_rect_header(&b).expect("parse");
        assert_eq!(r, RectHeader { x: 10, y: 20, width: 64, height: 48, encoding: 0 });
    }

    #[test]
    fn rect_header_handles_signed_encoding() {
        let mut b = vec![0u8; 8];
        b.extend_from_slice(&(-223i32).to_be_bytes()); // DesktopSize pseudo-encoding
        assert_eq!(parse_rect_header(&b).unwrap().encoding, -223);
    }

    #[test]
    fn encodes_client_messages() {
        assert_eq!(encode_fb_update_request(true, 0, 0, 800, 600), [3, 1, 0, 0, 0, 0, 3, 32, 2, 88]);
        assert_eq!(encode_pointer_event(0b01, 100, 200), [5, 1, 0, 100, 0, 200]);
        let ke = encode_key_event(true, 0x0061); // 'a'
        assert_eq!(ke, [4, 1, 0, 0, 0, 0, 0, 0x61]);
    }

    #[test]
    fn vnc_des_key_bit_reverses_and_pads() {
        // 0x01 (0b0000_0001) reverses to 0x80 (0b1000_0000).
        let k = vnc_des_key("\x01");
        assert_eq!(k[0], 0x80);
        assert_eq!(&k[1..], &[0u8; 7]); // NUL-padded tail
        // Over-length passwords are truncated to 8 bytes.
        let k2 = vnc_des_key("123456789");
        assert_eq!(k2.len(), 8);
        assert_eq!(k2[0], b'1'.reverse_bits());
    }
}
