#include "cfc-cpp/ReceivedFileStore.h"
#include <cassert>
#include <filesystem>
#include <fstream>
#include <iostream>
namespace fs = std::filesystem;
std::vector<uint8_t> encoded(const std::string& name, const std::string& data) {
    std::string header = std::string(1, '\x01') + name;
    std::vector<uint8_t> out(header.size() + 8 + ZSTD_compressBound(data.size()));
    size_t n = ZSTD_writeSkippableFrame(out.data(), out.size(), header.data(), header.size(), 0);
    assert(!ZSTD_isError(n));
    size_t size = ZSTD_compress(out.data() + n, out.size() - n, data.data(), data.size(), 3);
    assert(!ZSTD_isError(size)); out.resize(n + size); return out;
}
std::string read(const fs::path& p) { std::ifstream f(p, std::ios::binary); return {std::istreambuf_iterator<char>(f), {}}; }
int main() {
    char pattern[] = "/tmp/catio-store-test-XXXXXX";
    std::string dir = mkdtemp(pattern);
    auto save = [&](const std::string& name, const std::string& data) {
        auto result = store_received_file(dir, "test", encoded(name, data));
        assert(!result.empty()); assert(read(fs::path(dir) / result) == data); return result;
    };
    assert(save("Catio-奶油猫-🐈.txt", "hello") == "Catio-奶油猫-🐈.txt");
    assert(save("Catio-奶油猫-🐈.txt", "second") == "Catio-奶油猫-🐈 (1).txt");
    assert(save("../../escape.txt", "inside") == "escape.txt");
    assert(save("..\\..\\escape.txt", "inside") == "escape (1).txt");
    assert(save(".hidden", "visible") == "_.hidden");
    assert(save("empty.txt", "") == "empty.txt");
    assert(save("large.bin", std::string(5 * 1024 * 1024, '\0')) == "large.bin");
    fs::create_symlink("escape.txt", fs::path(dir) / "existing.txt");
    assert(save("existing.txt", "safe") == "existing (1).txt");
    assert(read(fs::path(dir) / "escape.txt") == "inside");
    auto truncated = encoded("bad.txt", "must never publish a partial file"); truncated.pop_back();
    assert(store_received_file(dir, "bad", truncated).empty());
    assert(!fs::exists(fs::path(dir) / "bad.txt"));
    assert(store_received_file(dir, "bad", {1,2,3,4,5}).empty());
    assert(store_received_file(dir + "/missing", "bad", encoded("x", "data")).empty());
    for (const auto& entry : fs::directory_iterator(dir)) assert(entry.path().filename().string().find(".incoming-") != 0);
    fs::remove_all(dir);
    std::cout << "PASS: Unicode, collision, traversal, hidden name, empty, 5 MiB decompression, symlink, corruption, IO failure, partial cleanup\n";
}
