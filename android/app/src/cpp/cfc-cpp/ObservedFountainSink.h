#pragma once
#include "fountain/fountain_decoder_sink.h"
#include "ReceivedFileStore.h"
#include <deque>
#include <mutex>

struct TransferSnapshot {
    uint64_t uniqueBytes = 0, received = 0, total = 0;
    unsigned streams = 0, completed = 0, errors = 0;
    bool finishing = false;
};

// Protocol unchanged. Serialize writes; publish a small UI cache without holding its lock during IO.
class ObservedFountainSink : public fountain_decoder_sink {
public:
    ObservedFountainSink(unsigned chunkSize, const std::string& directory)
        : fountain_decoder_sink(chunkSize, [this, directory](const std::string& fallback, const std::vector<uint8_t>& data) {
            { std::lock_guard<std::mutex> guard(_statusMutex); _status.finishing = true; }
            std::string name = store_received_file(directory, fallback, data);
            std::lock_guard<std::mutex> guard(_statusMutex);
            _status.finishing = false;
            if (name.empty()) ++_status.errors;
            else { ++_status.completed; _events.push_back(name); }
            return name;
        }) {}
    bool write(const char* data, unsigned length) {
        std::lock_guard<std::mutex> guard(_writeMutex);
        uint64_t added = 0;
        if (length % chunk_size() != 0) return false;
        for (unsigned offset = 0; offset < length; offset += chunk_size()) {
            FountainMetadata md(data + offset, chunk_size());
            if (!md.file_size() || is_done(md.id())) continue;
            auto it = _streams.find(stream_slot(md));
            const unsigned before = it == _streams.end() ? 0 : it->second.progress();
            int64_t result = decode_frame(data + offset, chunk_size());
            it = _streams.find(stream_slot(md));
            const unsigned after = it == _streams.end() ? before : it->second.progress();
            if (result > 0 || after > before) added += chunk_size() - FountainMetadata::md_size;
        }
        uint64_t received = 0, total = 0;
        for (const auto& entry : _streams) {
            const auto& stream = entry.second;
            total += stream.data_size();
            received += std::min<uint64_t>(stream.data_size(), uint64_t(stream.progress()) * stream.block_size());
        }
        std::lock_guard<std::mutex> statusGuard(_statusMutex);
        _status.uniqueBytes += added;
        _status.received = received; _status.total = total; _status.streams = _streams.size();
        return true;
    }
    TransferSnapshot snapshot() const {
        std::lock_guard<std::mutex> guard(_statusMutex); return _status;
    }
    std::string poll() {
        std::lock_guard<std::mutex> guard(_statusMutex);
        if (_events.empty()) return {};
        auto name = _events.front(); _events.pop_front(); return name;
    }
private:
    std::mutex _writeMutex;
    mutable std::mutex _statusMutex;
    TransferSnapshot _status;
    std::deque<std::string> _events;
};
