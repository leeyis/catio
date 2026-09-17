#pragma once
#include "ObservedFountainSink.h"
#include "encoder/Decoder.h"
#include "extractor/Scanner.h"
#include "extractor/Deskewer.h"
#include "concurrent/thread_pool.h"
#include <atomic>
#include <chrono>
#include <memory>
#include <mutex>
#include <opencv2/opencv.hpp>

class MultiThreadedDecoder {
public:
    MultiThreadedDecoder(const std::string& path, int mode)
        : _mode(mode), _writer(chunk_size(mode), path),
          _workers(std::clamp<int>(std::thread::hardware_concurrency() / 2, 1, 4)), _pool(_workers, 1) { _pool.start(); }
    ~MultiThreadedDecoder() { stop(); } // Join before writer and metrics members are destroyed.
    void stop() { _pool.stop(); }
    int mode() const { return _mode.load(); }
    int detected_mode() const { return _detected.load(); }
    bool set_mode(int mode) {
        if (mode && _writer.chunk_size() != chunk_size(mode)) return false;
        _mode = mode;
        if (!mode) _detected = 0;
        return true;
    }
    void add(const cv::Mat& source) {
        unsigned sequence = ++_submitted;
        // Bound memory and latency before the expensive full-frame copy. The upstream
        // lock-free queue allocates blocks, so producerLimit=1 is not a one-frame limit.
        if (_inflight.fetch_add(1) >= _workers + 1) { --_inflight; return; }
        int mode = _mode;
        if (!mode) { const int modes[]{68, 67, 66, 4}; mode = modes[(sequence - 1) % 4]; }
        cv::Mat image;
        try { image = source.clone(); } catch (...) { --_inflight; ++_processingErrors; return; }
        if (!_pool.try_execute([this, image, mode, sequence]() {
            struct Release { std::atomic<unsigned>& count; ~Release() { --count; } } release{_inflight};
            try {
                cimbar::Config::update(mode);
                cv::Rect roi(0, 0, image.cols, image.rows);
                {
                    std::lock_guard<std::mutex> guard(_geometryMutex);
                    if (_trackedSize == image.size() && std::chrono::steady_clock::now() - _trackedAt < std::chrono::milliseconds(600)) roi = _trackedRoi;
                }
                cv::Mat scanImage = image(roi);
                auto anchors = Scanner(scanImage).scan();
                if (anchors.size() < 4 && roi.area() < image.cols * image.rows) {
                    roi = cv::Rect(0, 0, image.cols, image.rows); scanImage = image;
                    anchors = Scanner(scanImage).scan();
                }
                // Uneven lighting can defeat Otsu; sample the adaptive path without
                // imposing its cost on every camera frame.
                if (anchors.size() < 4 && sequence % 6 == 0) anchors = Scanner(scanImage, false).scan();
                ++_scanned;
                std::array<double, 8> points{};
                if (anchors.size() >= 4) {
                    auto all = Corners(anchors).all();
                    for (int i = 0; i < 4; ++i) { points[i * 2] = (all[i].x + roi.x) / image.cols; points[i * 2 + 1] = (all[i].y + roi.y) / image.rows; }
                }
                {
                    std::lock_guard<std::mutex> guard(_geometryMutex);
                    if (sequence >= _geometrySequence) {
                        _geometrySequence = sequence; _anchors = std::min<size_t>(4, anchors.size());
                        _width = image.cols; _height = image.rows; _points = points;
                        _geometryAt = std::chrono::steady_clock::now();
                    }
                }
                if (anchors.size() < 4) return;
                ++_located;
                cv::Mat corrected = Deskewer().deskew(scanImage, Corners(anchors));
                if (corrected.empty()) return;
                thread_local std::unique_ptr<Decoder> decoder;
                thread_local int decoderMode = -1;
                if (decoderMode != mode) {
                    decoder = std::make_unique<Decoder>(cimbar::Config::ecc_bytes(), cimbar::Config::color_bits()); decoderMode = mode;
                }
                unsigned bytes = decoder->decode_fountain(corrected, _writer, false, mode == 4 ? 1 : 2);
                if (bytes) {
                    ++_decoded; if (_mode == 0) _detected = mode;
                    auto all = Corners(anchors).all();
                    cv::Rect box = cv::boundingRect(all);
                    int pad = std::max(60, std::max(box.width, box.height) / 5);
                    box = cv::Rect(box.x + roi.x - pad, box.y + roi.y - pad, box.width + pad * 2, box.height + pad * 2) & cv::Rect(0, 0, image.cols, image.rows);
                    std::lock_guard<std::mutex> guard(_geometryMutex);
                    if (sequence >= _trackedSequence) {
                        _trackedSequence = sequence; _trackedSize = image.size(); _trackedRoi = box; _trackedAt = std::chrono::steady_clock::now();
                    }
                }
            } catch (...) { ++_processingErrors; }
        })) --_inflight;
    }
    std::array<double, 27> snapshot() const {
        auto transfer = _writer.snapshot();
        std::array<double, 27> values{};
        values[0] = _submitted; values[1] = _scanned; values[2] = _located; values[3] = _decoded;
        values[4] = transfer.uniqueBytes;
        {
            std::lock_guard<std::mutex> guard(_geometryMutex);
            values[5] = _anchors; values[6] = _width; values[7] = _height;
            std::copy(_points.begin(), _points.end(), values.begin() + 8);
            values[16] = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - _geometryAt).count();
        }
        values[17] = transfer.total ? std::min(.99, double(transfer.received) / transfer.total) : 0;
        values[18] = transfer.streams; values[19] = transfer.completed; values[20] = _detected ? _detected.load() : _mode.load();
        values[21] = _pool.queued(); values[22] = transfer.errors; values[23] = transfer.total;
        values[24] = transfer.received; values[25] = _processingErrors; values[26] = transfer.finishing;
        return values;
    }
    std::string poll() { return _writer.poll(); }
private:
    static unsigned chunk_size(int mode) { return cimbar::Config::temp_conf(mode).fountain_chunk_size(); }
    std::atomic<int> _mode, _detected{0};
    std::atomic<unsigned> _submitted{0}, _scanned{0}, _located{0}, _decoded{0}, _processingErrors{0};
    mutable std::mutex _geometryMutex;
    unsigned _geometrySequence = 0, _anchors = 0, _width = 0, _height = 0;
    std::array<double, 8> _points{};
    std::chrono::steady_clock::time_point _geometryAt{};
    cv::Rect _trackedRoi;
    cv::Size _trackedSize;
    unsigned _trackedSequence = 0;
    std::chrono::steady_clock::time_point _trackedAt{};
    std::atomic<unsigned> _inflight{0};
    ObservedFountainSink _writer;
    unsigned _workers;
    turbo::thread_pool _pool;
};
