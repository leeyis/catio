// In-process russh SSH test server. Integration tests only.
//
// API verified against russh 0.61.2 (ring backend). Notable points vs a
// generic skeleton:
//   * `Session::data` takes `impl Into<bytes::Bytes>`, so we send `Vec<u8>`
//     (not `CryptoVec`).
//   * Server host key is generated with `PrivateKey::random(&mut rand::rng(),
//     Algorithm::Ed25519)` exactly like the upstream `echoserver` example.
//   * `shell_request` / `exec_request` call `session.channel_success(..)` so
//     the client's request future resolves successfully.
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use russh::server::{Auth, Config, Handler, Msg, Server, Session};
use russh::{Channel, ChannelId, Pty};
use russh::keys::{Algorithm, PrivateKey};
use russh::keys::ssh_key::PublicKey;

pub const TEST_USER: &str = "tester";
pub const TEST_PW: &str = "catio-test-pw";

#[derive(Clone)]
pub struct TestServer {
    /// Root directory served by the sftp subsystem (None → no sftp root;
    /// subsystem_request will still serve a throwaway temp dir per process).
    sftp_root: Option<PathBuf>,
}

pub struct TestHandler {
    /// Channels that have an active interactive shell (so `data` echoes).
    shell_on: HashSet<ChannelId>,
    /// Channels held until subsystem_request consumes them (for sftp).
    pending: HashMap<ChannelId, Channel<Msg>>,
    /// Root dir for the sftp backend on this connection.
    sftp_root: Option<PathBuf>,
}

impl Server for TestServer {
    type Handler = TestHandler;

    fn new_client(&mut self, _addr: Option<std::net::SocketAddr>) -> TestHandler {
        TestHandler {
            shell_on: HashSet::new(),
            pending: HashMap::new(),
            sftp_root: self.sftp_root.clone(),
        }
    }
}

impl Handler for TestHandler {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        if user == TEST_USER && password == TEST_PW {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::reject())
        }
    }

    async fn auth_publickey(&mut self, user: &str, _key: &PublicKey) -> Result<Auth, Self::Error> {
        // Test fixture: accept any key for the test user.
        if user == TEST_USER {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::reject())
        }
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        // Hold the channel so a later subsystem_request (sftp) can take its stream.
        self.pending.insert(channel.id(), channel);
        Ok(true)
    }

    async fn subsystem_request(
        &mut self,
        channel_id: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if name == "sftp" {
            let channel = match self.pending.remove(&channel_id) {
                Some(c) => c,
                None => {
                    session.channel_failure(channel_id)?;
                    return Ok(());
                }
            };
            session.channel_success(channel_id)?;
            // Serve the configured root, or a process-wide throwaway temp dir.
            let root = self
                .sftp_root
                .clone()
                .unwrap_or_else(std::env::temp_dir);
            let backend = SftpBackend::new(root);
            tokio::spawn(async move {
                russh_sftp::server::run(channel.into_stream(), backend).await;
            });
        } else {
            session.channel_failure(channel_id)?;
        }
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        _col_width: u32,
        _row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.shell_on.insert(channel);
        session.channel_success(channel)?;
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        // Echo the command back to stdout, then exit 0 and close.
        // NOTE: a trailing "\n" is appended (not byte-exact to the input) — exec-based
        // tests (A7/D) that assert on output must account for it.
        let mut out = data.to_vec();
        out.extend_from_slice(b"\n");
        session.data(channel, out)?;
        session.exit_status_request(channel, 0)?;
        session.close(channel)?;
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if self.shell_on.contains(&channel) {
            // Echo input bytes back to the client.
            session.data(channel, data.to_vec())?;
        }
        Ok(())
    }
}

/// Start a test server bound to a random localhost port; accept connections in
/// a background tokio task. Returns the bound address.
///
/// The sftp subsystem (if requested) serves a throwaway per-process temp dir;
/// for a LIST test with known contents use [`start_with_root`].
pub async fn start() -> std::net::SocketAddr {
    start_inner(None).await
}

/// Like [`start`], but the sftp subsystem serves the given `root` directory.
/// The caller pre-populates `root`; the list test passes that path to `read_dir`.
pub async fn start_with_root(root: PathBuf) -> std::net::SocketAddr {
    start_inner(Some(root)).await
}

async fn start_inner(sftp_root: Option<PathBuf>) -> std::net::SocketAddr {
    let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)
        .expect("generate ed25519 host key");
    let config = Arc::new(Config {
        keys: vec![key],
        ..Default::default()
    });

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind 127.0.0.1:0");
    let addr = listener.local_addr().expect("local_addr");

    tokio::spawn(async move {
        let mut server = TestServer { sftp_root };
        loop {
            let (socket, peer) = match listener.accept().await {
                Ok(v) => v,
                // Surface accept errors so a dead accept loop is diagnosable in
                // `cargo test` output instead of producing cryptic connect refusals.
                Err(e) => {
                    eprintln!("[test_server] accept error: {e}");
                    break;
                }
            };
            let handler = server.new_client(Some(peer));
            let cfg = config.clone();
            tokio::spawn(async move {
                let _ = russh::server::run_stream(cfg, socket, handler).await;
            });
        }
    });

    addr
}

// ─── 最小 SFTP 服务端后端（仅支持列目录所需的方法）────────────────────────────
//
// russh-sftp 2.3.0 server::Handler（已确认）：关联 `type Error`（这里用
// protocol::StatusCode），方法默认调用 `unimplemented()`。客户端 read_dir 流程为
// opendir(path) → 反复 readdir(handle) 直到收到 StatusCode::Eof。我们把绝对目录
// 路径直接当作 handle 用，并用 read_done 集合标记“已发送过一批”，再次 readdir 即
// 返回 Eof。FileAttributes::from(&std::fs::Metadata) 会填好 size/mtime 与 DIR 模式位
// （跨平台，含 Windows），故客户端 is_dir()/len() 正确。

use russh_sftp::protocol::{
    Attrs as SftpStatAttrs, Data as SftpData, File as SftpFile, FileAttributes as SftpAttrs,
    Handle as SftpHandle, Name as SftpName, OpenFlags, Status as SftpStatus, StatusCode,
    Version as SftpVersion,
};

struct SftpBackend {
    root: PathBuf,
    /// handle(绝对路径) → 是否已发送过该目录的条目。
    read_done: HashSet<String>,
    /// 打开的文件句柄："f:<n>" → (真实路径, std::fs::File)。B2 上传/下载用。
    files: HashMap<String, (PathBuf, std::fs::File)>,
    /// 文件句柄自增计数。
    next_file: u64,
}

impl SftpBackend {
    fn new(root: PathBuf) -> Self {
        Self {
            root,
            read_done: HashSet::new(),
            files: HashMap::new(),
            next_file: 0,
        }
    }

    /// 把客户端给的路径解析为真实文件系统路径。"." / "/" / "" → root；
    /// 绝对路径原样使用（list 测试传 root 的绝对路径）；相对路径 join 到 root
    /// （B2/B3 测试传 "uploaded.bin"、"newdir" 之类裸文件名）。
    fn resolve(&self, path: &str) -> PathBuf {
        if path.is_empty() || path == "." || path == "/" {
            self.root.clone()
        } else {
            let p = PathBuf::from(path);
            if p.is_absolute() {
                p
            } else {
                self.root.join(p)
            }
        }
    }

    fn ok_status(id: u32) -> SftpStatus {
        SftpStatus {
            id,
            status_code: StatusCode::Ok,
            error_message: "Ok".to_string(),
            language_tag: "en-US".to_string(),
        }
    }
}

impl russh_sftp::server::Handler for SftpBackend {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn init(
        &mut self,
        _version: u32,
        _extensions: std::collections::HashMap<String, String>,
    ) -> Result<SftpVersion, Self::Error> {
        Ok(SftpVersion::new())
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<SftpName, Self::Error> {
        let resolved = self.resolve(&path);
        let s = resolved.to_string_lossy().to_string();
        Ok(SftpName {
            id,
            files: vec![SftpFile::dummy(s)],
        })
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<SftpHandle, Self::Error> {
        let resolved = self.resolve(&path);
        if !resolved.is_dir() {
            return Err(StatusCode::NoSuchFile);
        }
        let handle = resolved.to_string_lossy().to_string();
        self.read_done.remove(&handle);
        Ok(SftpHandle { id, handle })
    }

    async fn readdir(&mut self, id: u32, handle: String) -> Result<SftpName, Self::Error> {
        if self.read_done.contains(&handle) {
            return Err(StatusCode::Eof);
        }
        self.read_done.insert(handle.clone());

        let entries = std::fs::read_dir(&handle).map_err(|_| StatusCode::Failure)?;
        let mut files = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let attrs: SftpAttrs = match entry.metadata() {
                Ok(m) => SftpAttrs::from(&m),
                Err(_) => SftpAttrs::default(),
            };
            files.push(SftpFile::new(name, attrs));
        }
        Ok(SftpName { id, files })
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<SftpStatAttrs, Self::Error> {
        let resolved = self.resolve(&path);
        let m = std::fs::metadata(&resolved).map_err(|_| StatusCode::NoSuchFile)?;
        Ok(SftpStatAttrs {
            id,
            attrs: SftpAttrs::from(&m),
        })
    }

    async fn lstat(&mut self, id: u32, path: String) -> Result<SftpStatAttrs, Self::Error> {
        self.stat(id, path).await
    }

    // ── B2: 文件读写（open/read/write/fstat）────────────────────────────────
    async fn open(
        &mut self,
        id: u32,
        filename: String,
        pflags: OpenFlags,
        _attrs: SftpAttrs,
    ) -> Result<SftpHandle, Self::Error> {
        let path = self.resolve(&filename);
        let mut opts = std::fs::OpenOptions::new();
        if pflags.contains(OpenFlags::READ) {
            opts.read(true);
        }
        if pflags.contains(OpenFlags::WRITE) {
            opts.write(true);
        }
        if pflags.contains(OpenFlags::CREATE) {
            opts.create(true);
        }
        if pflags.contains(OpenFlags::TRUNCATE) {
            opts.truncate(true);
        }
        if pflags.contains(OpenFlags::APPEND) {
            opts.append(true);
        }
        // 纯读时未设置任何写位 → 确保至少能读。
        if !pflags.contains(OpenFlags::READ) && !pflags.contains(OpenFlags::WRITE) {
            opts.read(true);
        }
        let f = opts.open(&path).map_err(|_| StatusCode::Failure)?;
        let handle = format!("f:{}", self.next_file);
        self.next_file += 1;
        self.files.insert(handle.clone(), (path, f));
        Ok(SftpHandle { id, handle })
    }

    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<SftpData, Self::Error> {
        use std::io::{Read, Seek, SeekFrom};
        let (_, f) = self.files.get_mut(&handle).ok_or(StatusCode::Failure)?;
        f.seek(SeekFrom::Start(offset))
            .map_err(|_| StatusCode::Failure)?;
        let mut buf = vec![0u8; len as usize];
        let n = f.read(&mut buf).map_err(|_| StatusCode::Failure)?;
        if n == 0 {
            return Err(StatusCode::Eof);
        }
        buf.truncate(n);
        Ok(SftpData { id, data: buf })
    }

    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<SftpStatus, Self::Error> {
        use std::io::{Seek, SeekFrom, Write};
        let (_, f) = self.files.get_mut(&handle).ok_or(StatusCode::Failure)?;
        f.seek(SeekFrom::Start(offset))
            .map_err(|_| StatusCode::Failure)?;
        f.write_all(&data).map_err(|_| StatusCode::Failure)?;
        Ok(Self::ok_status(id))
    }

    async fn fstat(&mut self, id: u32, handle: String) -> Result<SftpStatAttrs, Self::Error> {
        let (path, _) = self.files.get(&handle).ok_or(StatusCode::Failure)?;
        let m = std::fs::metadata(path).map_err(|_| StatusCode::NoSuchFile)?;
        Ok(SftpStatAttrs {
            id,
            attrs: SftpAttrs::from(&m),
        })
    }

    // ── B3: mkdir / rmdir / remove / rename ─────────────────────────────────
    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        _attrs: SftpAttrs,
    ) -> Result<SftpStatus, Self::Error> {
        std::fs::create_dir(self.resolve(&path)).map_err(|_| StatusCode::Failure)?;
        Ok(Self::ok_status(id))
    }

    async fn rmdir(&mut self, id: u32, path: String) -> Result<SftpStatus, Self::Error> {
        std::fs::remove_dir(self.resolve(&path)).map_err(|_| StatusCode::Failure)?;
        Ok(Self::ok_status(id))
    }

    async fn remove(&mut self, id: u32, filename: String) -> Result<SftpStatus, Self::Error> {
        std::fs::remove_file(self.resolve(&filename)).map_err(|_| StatusCode::Failure)?;
        Ok(Self::ok_status(id))
    }

    async fn rename(
        &mut self,
        id: u32,
        oldpath: String,
        newpath: String,
    ) -> Result<SftpStatus, Self::Error> {
        std::fs::rename(self.resolve(&oldpath), self.resolve(&newpath))
            .map_err(|_| StatusCode::Failure)?;
        Ok(Self::ok_status(id))
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<SftpStatus, Self::Error> {
        // 释放已打开的文件句柄（目录句柄不在该表里，忽略即可）。
        self.files.remove(&handle);
        Ok(Self::ok_status(id))
    }
}
