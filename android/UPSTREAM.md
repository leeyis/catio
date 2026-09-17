# Source provenance

Catio Android is based on [sz3/cfc](https://github.com/sz3/cfc) commit `e143ebd16154f3db17fbfdf8d0da71b1b50678a4` (v0.6.8). Initial Catio changes were recorded locally as `1e2d76f`. This directory is now maintained in the Catio repository.

`app/src/main/assets` is a flattened, unmodified copy of [sz3/cimbar-js-bits](https://github.com/sz3/cimbar-js-bits) commit `d617b9027670f23d35777501f630e49e8cf14476`. It is intentionally vendored as ordinary files so `git pull` retrieves everything. No nested Git repository or submodule is required. `app/build.gradle` verifies the original WASM digest. Custom sender UI lives separately in `catioAssets`.

The original MIT license and libcimbar MPL-2.0/dependency notices are retained. See `README.upstream.md`, `LICENSE`, `app/src/cpp/libcimbar/LICENSE` and the packaged `catio_notices.txt`.
