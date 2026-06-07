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
use std::collections::HashSet;
use std::sync::Arc;

use russh::server::{Auth, Config, Handler, Msg, Server, Session};
use russh::{Channel, ChannelId, Pty};
use russh::keys::{Algorithm, PrivateKey};
use russh::keys::ssh_key::PublicKey;

pub const TEST_USER: &str = "tester";
pub const TEST_PW: &str = "catio-test-pw";

#[derive(Clone)]
pub struct TestServer;

pub struct TestHandler {
    /// Channels that have an active interactive shell (so `data` echoes).
    shell_on: HashSet<ChannelId>,
}

impl Server for TestServer {
    type Handler = TestHandler;

    fn new_client(&mut self, _addr: Option<std::net::SocketAddr>) -> TestHandler {
        TestHandler {
            shell_on: HashSet::new(),
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
        _channel: Channel<Msg>,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        Ok(true)
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
pub async fn start() -> std::net::SocketAddr {
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
        let mut server = TestServer;
        loop {
            let (socket, peer) = match listener.accept().await {
                Ok(v) => v,
                Err(_) => break,
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
