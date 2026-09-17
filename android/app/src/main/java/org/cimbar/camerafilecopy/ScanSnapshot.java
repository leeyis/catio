package org.cimbar.camerafilecopy;

final class ScanSnapshot {
    final long submitted, scanned, located, decoded, uniqueBytes;
    final int anchors, width, height, streams, completed, mode, errors;
    final double[] corners = new double[8];
    final long geometryAge, total, received;
    final double progress;
    final boolean finishing;
    ScanSnapshot(double[] d) {
        if (d == null || d.length < 27) d = new double[27];
        submitted = (long)d[0]; scanned = (long)d[1]; located = (long)d[2]; decoded = (long)d[3]; uniqueBytes = (long)d[4];
        anchors = (int)d[5]; width = (int)d[6]; height = (int)d[7];
        System.arraycopy(d, 8, corners, 0, 8);
        geometryAge = (long)d[16]; progress = Math.max(0, Math.min(.99, d[17]));
        streams = (int)d[18]; completed = (int)d[19]; mode = (int)d[20]; errors = (int)d[22];
        total = (long)d[23]; received = (long)d[24]; finishing = d[26] != 0;
    }
}
