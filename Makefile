.PHONY: all clean distclean vmlinux

# `make` must build the project, not fetch the toolchain, so pin the default
# goal before including toolchain.mk (which defines the `toolchain` target).
.DEFAULT_GOAL := all

# Resolve clang, bpftool and the libbpf program headers from yeet's vendored
# toolchain cache (fetched on demand by the `toolchain` target), so the build
# needs no system BPF toolchain. A `make CLANG=…` CLI override still wins.
include build/toolchain.mk

ARCH    ?= $(shell uname -m | sed 's/x86_64/x86/; s/aarch64/arm64/')
# PATH fallbacks, used only when toolchain.mk resolved nothing (off-Linux, or
# no lock) — on Linux it has already set these to the vendored binaries.
CLANG   ?= clang
BPFTOOL ?= bpftool

# BPF headers (bpf_helpers.h, bpf_core_read.h, bpf_tracing.h) from libbpf.
# Prefer the vendored copy resolved by toolchain.mk; fall back to a system
# libbpf / libbpf-dev on the default include path.
LIBBPF_INCLUDE ?= $(if $(BPF_SYSINCLUDE),$(BPF_SYSINCLUDE),/usr/include)

OBJ     := bin/airtop.bpf.o
VMLINUX := include/vmlinux.h

CFLAGS = -O2 -g -Wall -target bpf \
         -D__TARGET_ARCH_$(ARCH) \
         -Iinclude -I$(LIBBPF_INCLUDE)

all: $(OBJ)

# Kernel type definitions for CO-RE, dumped from the running kernel's BTF.
# Regenerated automatically when missing; `make vmlinux` forces a refresh.
# `| toolchain` ensures the vendored bpftool is cached before the rule runs it.
$(VMLINUX): | toolchain
	sh build/gen-vmlinux.sh $(BPFTOOL) $@

vmlinux:
	@rm -f $(VMLINUX)
	@$(MAKE) $(VMLINUX)

$(OBJ): airtop.bpf.c $(VMLINUX) | toolchain
	@mkdir -p bin
	$(CLANG) $(CFLAGS) -c $< -o $@

clean:
	rm -f $(OBJ)

distclean: clean
	rm -f $(VMLINUX)
