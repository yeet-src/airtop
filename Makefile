.PHONY: all clean distclean vmlinux

ARCH    ?= $(shell uname -m | sed 's/x86_64/x86/; s/aarch64/arm64/')
CLANG   ?= clang
BPFTOOL ?= bpftool

# BPF headers (bpf_helpers.h, bpf_core_read.h, bpf_tracing.h) from libbpf.
# Install via your distro's libbpf / libbpf-dev package.
LIBBPF_INCLUDE ?= /usr/include

OBJ     := bin/airtop.bpf.o
VMLINUX := include/vmlinux.h

CFLAGS = -O2 -g -Wall -target bpf \
         -D__TARGET_ARCH_$(ARCH) \
         -D__IEEE80211_CHANNEL_STUB \
         -Iinclude -I$(LIBBPF_INCLUDE)

all: $(OBJ)

# Kernel type definitions for CO-RE, dumped from the running kernel's BTF.
# Regenerated automatically when missing; `make vmlinux` forces a refresh.
$(VMLINUX):
	@mkdir -p include
	$(BPFTOOL) btf dump file /sys/kernel/btf/vmlinux format c > $@

vmlinux:
	@rm -f $(VMLINUX)
	@$(MAKE) $(VMLINUX)

$(OBJ): airtop.bpf.c $(VMLINUX)
	@mkdir -p bin
	$(CLANG) $(CFLAGS) -c $< -o $@

clean:
	rm -f $(OBJ)

distclean: clean
	rm -f $(VMLINUX)
