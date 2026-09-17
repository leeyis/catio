#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
test_binary="$(mktemp /tmp/catio-native-test.XXXXXX)"
trap 'rm -f "$test_binary"' EXIT
"${CXX:-c++}" -std=c++17 -DZSTD_STATIC_LINKING_ONLY -Iapp/src/cpp -Iapp/src/cpp/libcimbar/src/third_party_lib \
  tests/native/received_file_store_test.cpp $(pkg-config --cflags --libs libzstd) -o "$test_binary"
"$test_binary"
