#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_core_read.h>
#include <bpf/bpf_tracing.h>

/* IEEE 802.11 frame-control bit layout (little-endian on the wire). */
#define FC_TYPE(fc)    (((fc) >> 2) & 0x3)
#define FC_SUBTYPE(fc) (((fc) >> 4) & 0xf)

#define FTYPE_MGMT      0
#define MGMT_PROBE_REQ  4
#define MGMT_PROBE_RESP 5
#define MGMT_BEACON     8

#define DOT11_HDR_LEN   24  /* fc + dur + 3 addrs + seq */
#define MGMT_FIXED_LEN  12  /* timestamp + beacon int + capability */
#define SSID_MAX        32

/* These mac80211/cfg80211 types live in module BTF, not vmlinux. We only
 * take pointers to the opaque ones, so forward declarations suffice for
 * the fentry prototype. */
struct ieee80211_hw;
struct ieee80211_sta;
struct ieee80211_mgmt; /* opaque — we read the frame as raw bytes */
struct wiphy;          /* opaque — only used as a pointer in on_bss */

/* `cfg80211_inform_bss` is only in the cfg80211 module BTF. Declare the
 * fields we read; CO-RE relocates their offsets by name at load. */

/* CO-RE stub: only center_freq is read; the relocator matches by name. */
struct ieee80211_channel {
    u32 center_freq;
};

struct cfg80211_inform_bss {
    struct ieee80211_channel *chan;
    s32 signal; /* mBm (dBm × 100) for MBM-type wiphys */
};

/* `ieee80211_rx_status` is overlaid on `skb->cb` by the wifi stack and
 * lives only in the module BTF. CO-RE relocates each field by name at
 * load, so literal offsets here are irrelevant — but `freq` must be
 * declared as the same 13-bit bitfield so the bitfield read resolves. */
struct ieee80211_rx_status {
    u16 freq: 13;
    u8  band;
    s8  signal;
};

struct dot11_evt {
    __u16 fc;
    __u8  ftype;
    __u8  fsubtype;
    __u8  addr1[6];
    __u8  addr2[6];
    __u8  addr3[6];
    __u16 seq;
    __s8  signal;   /* dBm from rx_status, 0 if unavailable */
    __u16 freq;     /* MHz from rx_status, 0 if unavailable */
    __u8  band;     /* nl80211_band: 0=2.4G 1=5G 3=6G */
    __u8  ssid_len;
    char  ssid[SSID_MAX + 1];
};

/* clang's BPF backend can drop BTF for a struct only reached through a
 * local pointer. Anchor it in a __used global so the ring-buf bind can
 * resolve it by name via `btf_struct`. */
__attribute__((used)) static const struct dot11_evt __dot11_evt_anchor;

/* Scan-result (AP discovery) event — one per BSS the kernel learns of,
 * including firmware/hardware-scan results that bypass the RX path. */
struct ap_evt {
    __u8  bssid[6];
    __u16 freq;     /* MHz */
    __s8  signal;   /* dBm */
    __u8  ssid_len;
    char  ssid[SSID_MAX + 1];
};
__attribute__((used)) static const struct ap_evt __ap_evt_anchor;

struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 1 << 18);
} frames SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 1 << 18);
} aps SEC(".maps");

/* mac80211 RX funnel: the driver hands every received frame here with
 * `skb->data` pointing at the raw 802.11 MAC header (no radiotap, not
 * yet decapsulated). Works in managed mode — no monitor interface. */
SEC("fentry/ieee80211_rx_list")
int BPF_PROG(on_rx, struct ieee80211_hw *hw, struct ieee80211_sta *sta,
             struct sk_buff *skb)
{
    __u32 len           = BPF_CORE_READ(skb, len);
    const __u8 *data    = BPF_CORE_READ(skb, data);
    if (len < DOT11_HDR_LEN)
        return 0;

    __u8 hdr[DOT11_HDR_LEN];
    if (bpf_probe_read_kernel(hdr, sizeof(hdr), data))
        return 0;

    __u16 fc  = hdr[0] | (hdr[1] << 8);
    __u16 seq = (hdr[22] | (hdr[23] << 8)) >> 4;

    struct ieee80211_rx_status *st = (void *)&skb->cb;
    __s8  signal = BPF_CORE_READ(st, signal);
    __u8  band   = BPF_CORE_READ(st, band);
    __u16 freq   = BPF_CORE_READ_BITFIELD_PROBED(st, freq);

    struct dot11_evt *e = bpf_ringbuf_reserve(&frames, sizeof(*e), 0);
    if (!e)
        return 0;

    e->fc       = fc;
    e->ftype    = FC_TYPE(fc);
    e->fsubtype = FC_SUBTYPE(fc);
    e->seq      = seq;
    e->signal   = signal;
    e->freq     = freq;
    e->band     = band;
    e->ssid_len = 0;
    e->ssid[0]  = '\0';
    __builtin_memcpy(e->addr1, hdr + 4,  6);
    __builtin_memcpy(e->addr2, hdr + 10, 6);
    __builtin_memcpy(e->addr3, hdr + 16, 6);

    /* Beacon-class management frames carry the SSID as the first tagged
     * element. Probe requests have no fixed body; beacons and probe
     * responses prepend a 12-byte fixed field block. */
    if (e->ftype == FTYPE_MGMT) {
        int body = -1;
        if (e->fsubtype == MGMT_PROBE_REQ)
            body = DOT11_HDR_LEN;
        else if (e->fsubtype == MGMT_BEACON || e->fsubtype == MGMT_PROBE_RESP)
            body = DOT11_HDR_LEN + MGMT_FIXED_LEN;

        __u8 tag[2 + SSID_MAX];
        if (body >= 0 && bpf_probe_read_kernel(tag, sizeof(tag), data + body) == 0
            && tag[0] == 0) {
            __u8 slen = tag[1];
            if (slen > SSID_MAX)
                slen = SSID_MAX;
            e->ssid_len = slen;
#pragma clang loop unroll(full)
            for (int i = 0; i < SSID_MAX; i++) {
                if (i < slen)
                    e->ssid[i] = tag[2 + i];
            }
            e->ssid[slen] = '\0';
        }
    }

    bpf_ringbuf_submit(e, 0);
    return 0;
}

/* cfg80211 scan-result chokepoint: every BSS the kernel learns of — from
 * software scans, hardware/firmware-offloaded scans (rtw89), and probe
 * responses — passes through here with the full beacon/probe-resp frame.
 * Hooking it surfaces every nearby SSID in managed mode, no monitor. */
SEC("fentry/cfg80211_inform_bss_frame_data")
int BPF_PROG(on_bss, struct wiphy *wiphy, struct cfg80211_inform_bss *bdata,
             struct ieee80211_mgmt *mgmt, __u64 len)
{
    if (len < DOT11_HDR_LEN + MGMT_FIXED_LEN + 2)
        return 0;

    /* Beacon/probe-resp: 24-byte MAC header, 12-byte fixed body, then
     * tagged IEs. Read header + first IE (SSID is element id 0). */
    __u8 buf[DOT11_HDR_LEN + MGMT_FIXED_LEN + 2 + SSID_MAX];
    if (bpf_probe_read_kernel(buf, sizeof(buf), mgmt))
        return 0;

    struct ap_evt *e = bpf_ringbuf_reserve(&aps, sizeof(*e), 0);
    if (!e)
        return 0;

    __builtin_memcpy(e->bssid, buf + 16, 6); /* addr3 = BSSID */
    e->ssid_len = 0;
    e->ssid[0] = '\0';

    __s32 mbm = BPF_CORE_READ(bdata, signal);
    e->signal = (__s8)(mbm / 100);          /* mBm → dBm */
    e->freq = BPF_CORE_READ(bdata, chan, center_freq);

    const __u8 *tag = buf + DOT11_HDR_LEN + MGMT_FIXED_LEN;
    if (tag[0] == 0) {                       /* SSID element */
        __u8 slen = tag[1];
        if (slen > SSID_MAX)
            slen = SSID_MAX;
        e->ssid_len = slen;
#pragma clang loop unroll(full)
        for (int i = 0; i < SSID_MAX; i++)
            if (i < slen)
                e->ssid[i] = tag[2 + i];
        e->ssid[slen] = '\0';
    }

    bpf_ringbuf_submit(e, 0);
    return 0;
}

char LICENSE[] SEC("license") = "GPL";
