mod common;
use common::test_server;

// 前置核实（设计文档 §9）：分段并行 SFTP 引擎依赖测试服 `SftpBackend` 具备以下能力——
//   * `open_with_flags`（CREATE|TRUNCATE|WRITE 预建、WRITE-only 重开分段写）；
//   * 任意 offset 的 `write`，且写到 EOF 之后能自动扩展文件；
//   * `metadata`/`fstat` 返回正确 size；
//   * 任意 offset 的 `read` 取回对应区间字节；
//   * `remove_file` 删除半成品。
// 本测试用客户端 `russh_sftp::client::SftpSession` 直接驱动 backend，复刻分段上传/下载
// 的真实读写形态（§5.2 / §5.3），证明 backend 能支撑该引擎；无需走 catio 业务层。

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use std::io::SeekFrom;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use catio_lib::ssh::conn::{connect_authenticated, AuthMethod, ClientHandler, ConnectArgs};

/// 在测试服上开一条 sftp 子系统 channel 并建 `SftpSession`。
async fn open_sftp(
    addr: std::net::SocketAddr,
) -> (russh::client::Handle<ClientHandler>, SftpSession) {
    let args = ConnectArgs {
        host: addr.ip().to_string(),
        port: addr.port(),
        user: test_server::TEST_USER.into(),
        auth: AuthMethod::Password,
        secret: Some(test_server::TEST_PW.into()),
        jump: None,
    };
    let (handle, _fp, _, _) = connect_authenticated(&args).await.expect("connect");
    let channel = handle.channel_open_session().await.expect("open channel");
    channel
        .request_subsystem(true, "sftp")
        .await
        .expect("request sftp subsystem");
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .expect("init sftp session");
    (handle, sftp)
}

// 复刻「分段上传后下载回读」：多段任意 offset 写（含自动扩展），再 metadata 取 size，
// 再多段任意 offset 读回，断言每段字节一致、总大小一致。
#[tokio::test]
async fn segmented_arbitrary_offset_round_trip() {
    let root = std::env::temp_dir().join(format!("catio-sftp-bk-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let addr = test_server::start_with_root(root.clone()).await;
    let (handle, sftp) = open_sftp(addr).await;

    let remote = "seg.bin";
    // 构造 4 段、各不同内容的负载（每段长度不同，含非整除余数）。
    let segs: [Vec<u8>; 4] = [
        vec![0xA1u8; 5000],
        vec![0xB2u8; 4096],
        vec![0xC3u8; 7000],
        vec![0xD4u8; 3333],
    ];
    let mut offsets = Vec::new();
    let mut acc = 0u64;
    for s in &segs {
        offsets.push(acc);
        acc += s.len() as u64;
    }
    let total = acc;

    // §5.3 step 2：先 CREATE|TRUNCATE|WRITE 预建并关闭，避免分段并发 TRUNCATE 竞态。
    {
        let mut f = sftp
            .open_with_flags(
                remote,
                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            )
            .await
            .expect("pre-create remote");
        f.shutdown().await.ok();
    }

    // §5.3 step 3：每段 WRITE-only 重开、seek 到任意 offset、写入（验证任意 offset 写 + 自动扩展）。
    // 逆序写以确保不是顺序追加，真正考验任意 offset 定位与自动扩展。
    for i in (0..segs.len()).rev() {
        let mut f = sftp
            .open_with_flags(remote, OpenFlags::WRITE)
            .await
            .expect("reopen remote write");
        f.seek(SeekFrom::Start(offsets[i])).await.expect("seek write");
        f.write_all(&segs[i]).await.expect("segment write");
        f.flush().await.ok();
        f.shutdown().await.ok();
    }

    // §5.2 step 1：metadata().size 应等于总长度。
    let meta = sftp.metadata(remote).await.expect("metadata");
    assert_eq!(meta.size.unwrap_or(0), total, "远端文件大小应等于各段之和");

    // §5.2 step 3：每段 READ 重开、seek 到任意 offset、读回，逐字节比对。
    for i in 0..segs.len() {
        let mut f = sftp
            .open_with_flags(remote, OpenFlags::READ)
            .await
            .expect("reopen remote read");
        f.seek(SeekFrom::Start(offsets[i])).await.expect("seek read");
        let mut buf = vec![0u8; segs[i].len()];
        f.read_exact(&mut buf).await.expect("segment read");
        assert_eq!(buf, segs[i], "第 {i} 段读回内容应与写入一致");
        f.shutdown().await.ok();
    }

    // §5.3/§5.4 清理：remove_file 删除后应不复存在。
    sftp.remove_file(remote).await.expect("remove file");
    assert!(
        !root.join(remote).exists(),
        "remove_file 后远端文件应被删除"
    );

    handle
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await
        .ok();
    let _ = std::fs::remove_dir_all(&root);
}

// 单独验证「写到 EOF 之后留洞」的自动扩展：只写文件尾部一段（offset > 0），
// 文件长度应扩展到 offset+len，且该段可正确读回。分段下载本地 set_len 预占位、
// 分段上传末段写远端尾部，都依赖这种自动扩展语义。
#[tokio::test]
async fn write_past_eof_auto_extends() {
    let root = std::env::temp_dir().join(format!("catio-sftp-ext-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let addr = test_server::start_with_root(root.clone()).await;
    let (handle, sftp) = open_sftp(addr).await;

    let remote = "hole.bin";
    let tail = vec![0x7Eu8; 1024];
    let offset = 1_000_000u64; // 远超当前 0 长度

    {
        let mut f = sftp
            .open_with_flags(
                remote,
                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            )
            .await
            .expect("create");
        f.shutdown().await.ok();
    }
    {
        let mut f = sftp
            .open_with_flags(remote, OpenFlags::WRITE)
            .await
            .expect("reopen write");
        f.seek(SeekFrom::Start(offset)).await.expect("seek");
        f.write_all(&tail).await.expect("write tail");
        f.flush().await.ok();
        f.shutdown().await.ok();
    }

    let meta = sftp.metadata(remote).await.expect("metadata");
    assert_eq!(
        meta.size.unwrap_or(0),
        offset + tail.len() as u64,
        "写到 EOF 之后应自动扩展到 offset+len"
    );

    let mut f = sftp
        .open_with_flags(remote, OpenFlags::READ)
        .await
        .expect("reopen read");
    f.seek(SeekFrom::Start(offset)).await.expect("seek read");
    let mut buf = vec![0u8; tail.len()];
    f.read_exact(&mut buf).await.expect("read tail");
    assert_eq!(buf, tail, "尾部段读回应与写入一致");
    f.shutdown().await.ok();

    sftp.remove_file(remote).await.expect("remove");
    handle
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await
        .ok();
    let _ = std::fs::remove_dir_all(&root);
}
