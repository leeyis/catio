mod common;
use base64::{engine::general_purpose::STANDARD, Engine};
use catio_lib::{
    optical::MAX_BYTES,
    server::{build_router, AppState},
    ssh::{
        conn::{connect_authenticated, AuthMethod, ConnectArgs},
        manager::Session,
    },
};
use common::test_server;
use serde_json::{json, Value};

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .cookie_store(true)
        .build()
        .unwrap()
}
async fn invoke(cl: &reqwest::Client, url: &str, cmd: &str, args: Value) -> (u16, Value) {
    let r = cl
        .post(format!("{url}/api/invoke"))
        .json(&json!({"cmd":cmd,"args":args}))
        .send()
        .await
        .unwrap();
    (r.status().as_u16(), r.json().await.unwrap())
}
#[tokio::test]
async fn optical_http_auth_isolation_and_real_sftp_roundtrip() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("remote");
    std::fs::create_dir(&root).unwrap();
    let bytes: Vec<u8> = (0..MAX_BYTES).map(|i| (i % 256) as u8).collect();
    let filename = "中文文件.bin";
    std::fs::write(root.join(filename), &bytes).unwrap();
    std::fs::write(root.join("oversize.bin"), vec![0; MAX_BYTES + 1]).unwrap();
    std::fs::write(root.join("empty.bin"), []).unwrap();
    std::fs::create_dir(root.join("directory")).unwrap();
    let addr = test_server::start_with_root(root).await;
    let (handle, _, forwarded, jump) = connect_authenticated(&ConnectArgs {
        host: addr.ip().to_string(),
        port: addr.port(),
        user: test_server::TEST_USER.into(),
        auth: AuthMethod::Password,
        secret: Some(test_server::TEST_PW.into()),
        jump: None,
    })
    .await
    .unwrap();
    let state = AppState::new(tmp.path().into(), tmp.path().join("data")).unwrap();
    state
        .ssh
        .insert(
            "owned-session".into(),
            Session {
                handle,
                host: addr.ip().to_string(),
                user: test_server::TEST_USER.into(),
                terms: Default::default(),
                forwarded,
                _jump: jump,
            },
        )
        .await;
    state
        .ssh_owners
        .lock()
        .unwrap()
        .insert("owned-session".into(), 1);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task =
        tokio::spawn(async move { axum::serve(listener, build_router(state)).await.unwrap() });
    let admin = client();
    let alice = client();
    let other_tab = client();
    assert_eq!(
        invoke(&admin, &url, "optical_status", json!({})).await.0,
        401
    );
    assert_eq!(
        invoke(
            &admin,
            &url,
            "auth_bootstrap",
            json!({"username":"admin","password":"account-test-pass"})
        )
        .await
        .0,
        200
    );
    assert_eq!(
        invoke(
            &alice,
            &url,
            "auth_register",
            json!({"username":"alice","password":"account-test-pass"})
        )
        .await
        .0,
        200
    );
    let unlock = json!({"passphrase":"optical-test-pass","setup":true});
    assert_eq!(
        invoke(&alice, &url, "optical_unlock", unlock.clone())
            .await
            .0,
        400
    );
    let (status, grant) = invoke(&admin, &url, "optical_unlock", unlock).await;
    assert_eq!(status, 200, "{grant}");
    let grant = grant.as_str().unwrap();
    let (_, alice_grant) = invoke(
        &alice,
        &url,
        "optical_unlock",
        json!({"passphrase":"optical-test-pass","setup":false}),
    )
    .await;
    assert!(alice_grant.is_string());
    assert_eq!(invoke(&alice,&url,"optical_read",json!({"token":alice_grant,"requestId":"own-grant","sessionId":"owned-session","path":filename})).await.0,400);
    let read = |id: &str, path: &str| json!({"token":grant,"requestId":id,"sessionId":"owned-session","path":path});
    assert_eq!(
        invoke(&alice, &url, "optical_check", json!({"token":grant}))
            .await
            .1,
        false
    );
    assert_eq!(
        invoke(&alice, &url, "optical_read", read("stolen", filename))
            .await
            .0,
        400
    );
    assert_eq!(
        invoke(
            &other_tab,
            &url,
            "auth_login",
            json!({"username":"admin","password":"account-test-pass"})
        )
        .await
        .0,
        200
    );
    assert_eq!(
        invoke(&other_tab, &url, "optical_check", json!({"token":grant}))
            .await
            .1,
        false
    );
    let (code, file) = invoke(&admin, &url, "optical_read", read("max", filename)).await;
    assert_eq!(code, 200, "{file}");
    assert_eq!(file["name"], filename);
    assert_eq!(
        STANDARD.decode(file["data"].as_str().unwrap()).unwrap(),
        bytes
    );
    assert_eq!(
        invoke(&admin, &url, "optical_read", read("large", "oversize.bin"))
            .await
            .1["error"],
        "optical.tooLarge"
    );
    assert_eq!(
        invoke(&admin, &url, "optical_read", read("dir", "directory"))
            .await
            .1["error"],
        "optical.notFile"
    );
    assert_eq!(
        invoke(&admin, &url, "optical_read", read("empty", "empty.bin"))
            .await
            .1["data"],
        ""
    );
    assert_eq!(
        invoke(
            &admin,
            &url,
            "optical_cancel",
            json!({"token":grant,"requestId":"cancelled"})
        )
        .await
        .0,
        200
    );
    assert_eq!(
        invoke(&admin, &url, "optical_read", read("cancelled", filename))
            .await
            .1["error"],
        "optical.cancelled"
    );
    assert_eq!(
        invoke(&admin, &url, "optical_lock", json!({"token":grant}))
            .await
            .0,
        200
    );
    assert_eq!(
        invoke(&admin, &url, "optical_read", read("locked", filename))
            .await
            .1["error"],
        "optical.locked"
    );
    let (_, second) = invoke(
        &admin,
        &url,
        "optical_unlock",
        json!({"passphrase":"optical-test-pass","setup":false}),
    )
    .await;
    assert!(second.is_string());
    invoke(&admin, &url, "auth_logout", json!({})).await;
    invoke(
        &admin,
        &url,
        "auth_login",
        json!({"username":"admin","password":"account-test-pass"}),
    )
    .await;
    assert_eq!(
        invoke(&admin, &url, "optical_check", json!({"token":second}))
            .await
            .1,
        false
    );
    // Deleting a user revokes their optical grants as well as their HTTP login.
    assert_eq!(
        invoke(&admin, &url, "user_delete", json!({"id":2})).await.0,
        200
    );
    assert_eq!(
        invoke(&alice, &url, "optical_check", json!({"token":alice_grant}))
            .await
            .0,
        401
    );
    task.abort();
}
