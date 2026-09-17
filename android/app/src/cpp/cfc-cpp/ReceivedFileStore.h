#pragma once
#include "zstd/zstd.h"
#include <algorithm>
#include <array>
#include <cerrno>
#include <cstdio>
#include <fcntl.h>
#include <mutex>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>
#ifdef __ANDROID__
#include <sys/syscall.h>
#endif

// Android SELinux denies hard links in app data. Prefer the kernel no-replace rename.
// The legacy fallback is serialized and only used in this app's private directory.
inline int publish_received_file(const char* source, const char* destination) {
#ifdef __ANDROID__
    if (syscall(SYS_renameat2, AT_FDCWD, source, AT_FDCWD, destination, 1 /* RENAME_NOREPLACE */) == 0) return 0;
    if (errno != ENOSYS && errno != EINVAL) return -1;
    static std::mutex publishMutex;
    std::lock_guard<std::mutex> guard(publishMutex);
    struct stat existing{};
    if (lstat(destination, &existing) == 0) { errno = EEXIST; return -1; }
    if (errno != ENOENT) return -1;
    return rename(source, destination);
#else
    return ::link(source, destination);
#endif
}

// Publish only verified files. An export cancellation never deletes this internal copy.
inline std::string store_received_file(const std::string& directory, const std::string& fallback,
                                      const std::vector<uint8_t>& compressed) {
    std::string name;
    if (ZSTD_isSkippableFrame(compressed.data(), compressed.size())) {
        std::array<char, 1024> header{};
        size_t n = ZSTD_readSkippableFrame(header.data(), header.size(), nullptr, compressed.data(), compressed.size());
        if (!ZSTD_isError(n) && n > 1 && n <= header.size() && header[0] == 1)
            name.assign(header.data() + 1, n - 1);
    }
    auto slash = name.find_last_of("/\\");
    if (slash != std::string::npos) name = name.substr(slash + 1);
    name.erase(std::remove_if(name.begin(), name.end(), [](unsigned char c) { return c < 32 || c == 127; }), name.end());
    if (name.empty() || name == "." || name == ".." || name.size() > 220) name = "received-" + fallback;
    if (name.front() == '.') name.insert(0, "_");
    std::string temporary = directory + "/.incoming-XXXXXX";
    std::vector<char> temp(temporary.begin(), temporary.end()); temp.push_back(0);
    int fd = mkstemp(temp.data());
    if (fd < 0) return {};
    ZSTD_DStream* stream = ZSTD_createDStream();
    bool good = stream && !ZSTD_isError(ZSTD_initDStream(stream));
    std::array<uint8_t, 128 * 1024> buffer{};
    ZSTD_inBuffer input{compressed.data(), compressed.size(), 0};
    size_t remaining = 1, written = 0;
    while (good && input.pos < input.size) {
        ZSTD_outBuffer output{buffer.data(), buffer.size(), 0};
        const size_t before = input.pos;
        remaining = ZSTD_decompressStream(stream, &output, &input);
        // Protect phone storage from compressed bombs; distinct from Catio's sender limit.
        if (ZSTD_isError(remaining) || written + output.pos > 512ULL * 1024 * 1024 ||
            (before == input.pos && output.pos == 0)) { good = false; break; }
        size_t offset = 0;
        while (offset < output.pos) {
            ssize_t n = ::write(fd, buffer.data() + offset, output.pos - offset);
            if (n < 0 && errno == EINTR) continue;
            if (n <= 0) { good = false; break; }
            offset += static_cast<size_t>(n);
        }
        written += output.pos;
    }
    good = good && remaining == 0 && fsync(fd) == 0;
    if (close(fd) != 0) good = false;
    if (stream) ZSTD_freeDStream(stream);
    std::string result;
    if (good) {
        // Publish the complete file without replacing an existing file or symlink.
        auto dot = name.find_last_of('.');
        std::string stem = dot == std::string::npos ? name : name.substr(0, dot);
        std::string ext = dot == std::string::npos ? "" : name.substr(dot);
        for (int i = 0; i < 10000; ++i) {
            std::string candidate = i == 0 ? name : stem + " (" + std::to_string(i) + ")" + ext;
            if (publish_received_file(temp.data(), (directory + "/" + candidate).c_str()) == 0) { result = candidate; break; }
            if (errno != EEXIST) break;
        }
    }
    ::unlink(temp.data());
    return result;
}
