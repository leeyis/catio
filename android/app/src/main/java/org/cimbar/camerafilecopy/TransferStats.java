package org.cimbar.camerafilecopy;

import java.util.ArrayDeque;

/** Rolling, monotonic-clock statistics. Repeated fountain packets contribute zero bytes. */
final class TransferStats {
    private static final class Sample {
        final long time, bytes, scanned, decoded;
        Sample(long t, ScanSnapshot s) { time=t; bytes=s.uniqueBytes; scanned=s.scanned; decoded=s.decoded; }
    }
    private final ArrayDeque<Sample> samples = new ArrayDeque<>();
    private long lastUseful = -1, lastDecode = -1;
    double bytesPerSecond;
    int recognitionPercent = -1;
    long stalledMillis, sinceDecodeMillis = Long.MAX_VALUE;

    void clear() { samples.clear(); lastUseful=-1; lastDecode=-1; bytesPerSecond=0; recognitionPercent=-1; stalledMillis=0; sinceDecodeMillis=Long.MAX_VALUE; }
    void update(long now, ScanSnapshot s, boolean paused) {
        if (paused) { clear(); return; }
        Sample previous = samples.peekLast();
        if (previous != null && (s.uniqueBytes < previous.bytes || s.scanned < previous.scanned || now < previous.time)) { clear(); previous=null; }
        if (previous == null || s.uniqueBytes > previous.bytes) lastUseful=now;
        if (previous != null && s.decoded > previous.decoded) lastDecode=now;
        samples.addLast(new Sample(now,s));
        while (samples.size() > 1 && samples.peekFirst().time < now-3000) samples.removeFirst();
        Sample first=samples.peekFirst();
        long elapsed=now-first.time;
        stalledMillis = Math.max(0, now-lastUseful);
        sinceDecodeMillis=lastDecode < 0 ? Long.MAX_VALUE : now-lastDecode;
        bytesPerSecond = elapsed >= 250 && stalledMillis < 2500 ? (s.uniqueBytes-first.bytes)*1000.0/elapsed : 0;
        long scans=s.scanned-first.scanned;
        recognitionPercent=scans > 0 ? (int)Math.min(100, Math.max(0,(s.decoded-first.decoded)*100/scans)) : -1;
    }
}
