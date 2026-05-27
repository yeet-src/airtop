# airtop

**htop for the airwaves** — a live 802.11 (Wi-Fi) RF dashboard in your terminal.

<p align="center">
  <img src="https://img.shields.io/badge/platform-Linux-1793D1" alt="Linux">
  <img src="https://img.shields.io/badge/built%20with-yeet%20%2B%20eBPF-8A2BE2" alt="yeet + eBPF">
  <img src="https://img.shields.io/badge/license-GPL-3DA639" alt="GPL">
</p>

<p align="center">
  <img src="assets/airtop.gif" alt="airtop running in anonymize mode" width="820">
</p>

airtop turns the invisible Wi-Fi traffic around you into a live, full-screen
terminal dashboard — a frequency spectrum of nearby access points, per-station
signal traces, a frame-type activity feed, a signal-strength histogram, and a
rolling list of discovered networks — all drawn with braille/block graphics and
powered by [yeet](https://yeet.cx) + eBPF.

> [!TIP]
> **No monitor mode, no raw sockets.** airtop attaches eBPF programs to the
> kernel's Wi-Fi stack and reads 802.11 frames as they flow through
> `mac80211`/`cfg80211`, so it runs on your normal, connected interface
> without dropping your link.

## Quick start

```sh
curl -fsSL https://yeet.cx | sh
yeet run https://github.com/yeet-src/airtop
```

For a shareable screenshot, anonymize SSIDs/MACs (your network and your
neighbors' get relabeled `network-01`, `station-02`, …):

```sh
yeet run https://github.com/yeet-src/airtop -- --anonymize
```

Runs until `Ctrl-C`; resize the terminal and the layout reflows (it wants at
least **80×24**). To surface neighboring networks, the kernel needs scan
results — your OS scans periodically on its own, or force one:

```sh
nmcli dev wifi rescan        # or: iw dev <iface> scan
```

## A 60-second 802.11 primer

Wi-Fi is the IEEE **802.11** family of standards. Here's the mental model for
what airtop visualizes:

- **Everything is a frame.** Your laptop, phone, and router exchange short
  radio packets called *frames*. Every frame carries MAC addresses, and one of
  them — the **BSSID** — identifies the access point it belongs to.
- **Three classes of frame:**

  | Class | Examples | Purpose |
  |---|---|---|
  | **Management** | Beacon, Probe, Auth, Assoc, **Deauth** | advertise, join, and leave networks |
  | **Control** | ACK, RTS/CTS | coordinate who gets to talk |
  | **Data** | your actual traffic | carry payloads |

- **Access points beacon.** An AP announces itself ~10 times a second with a
  *beacon* frame carrying its network name (**SSID**) and BSSID. That's how
  your phone's Wi-Fi list gets populated — and how airtop discovers APs.
- **Channels & frequency.** Wi-Fi lives in bands — **2.4 GHz, 5 GHz, 6 GHz** —
  each split into *channels*, and every channel is a center frequency in MHz
  (channel 6 ≈ 2437 MHz, channel 161 ≈ 5805 MHz). A radio listens to one
  channel at a time, which is why you mostly see traffic on *your* channel.
- **Signal strength (RSSI)** is measured in **dBm** — always negative, and
  closer to zero is stronger:

  | RSSI | quality |
  |---|---|
  | −30 … −50 dBm | excellent (right next to it) |
  | −50 … −67 dBm | good |
  | −67 … −80 dBm | usable |
  | −80 … −90 dBm | weak / marginal |

## What you're looking at

Each panel maps directly onto the concepts above:

- **Header** — uptime, total frames seen, live stations, discovered APs,
  beacon count, deauth count (red if any), and your current channel.
- **Frequency spectrum** — every discovered AP drawn as a signal "hump"
  positioned at its real center frequency on a MHz axis. Height and color show
  RSSI; the label is the SSID + dBm. Overlapping humps reveal co-channel
  congestion — the classic Wi-Fi-analyzer view.
- **RSSI × time** — a braille line graph per *live* station, plotting its
  signal (dBm) over the last several seconds. Watch a link fade as a device
  walks away.
- **Frame feed** — a heatmap of frame types (Beacon / Probe / Auth / Assoc /
  **Deauth** / Data / Control) over time; cell color = how many of that type
  arrived per slice. A deauth flood lights up that row instantly.
- **Signal histogram** — distribution of received frames by RSSI (frame count
  vs dBm), with numeric axes — the "shape" of your RF environment.
- **Access points** — discovered SSIDs with channel, a signal gauge, and dBm,
  sorted strongest-first.

## How it works

A single BPF object (`airtop.bpf.c`) attaches two `fentry` programs and streams
events to userspace over ring buffers:

| Hook | What it captures |
|---|---|
| `fentry/ieee80211_rx_list` | every received 802.11 frame — type/subtype, addresses, and RSSI from `ieee80211_rx_status` |
| `fentry/cfg80211_inform_bss_frame_data` | every AP the kernel's scans discover — SSID, channel, signal |

The dashboard runs in yeet's V8 runtime, subscribing to those ring buffers and
rendering the terminal UI:

```
main.js       entry: tty size, render loop, BPF bind/subscribe
state.js      live data + frame/scan ingest
render.js     ANSI, color ramps, braille canvas/charts (pure)
dashboard.js  panels + layout (renderDashboard)
```

## Requirements

> [!IMPORTANT]
> Needs **Linux with BTF** (`CONFIG_DEBUG_INFO_BTF=y`) and module BTF
> (`CONFIG_DEBUG_INFO_BTF_MODULES=y`) — the default on most current distros
> (Arch, Fedora, Ubuntu, Debian 12+). CO-RE means no per-kernel recompile.

- A Wi-Fi interface and the `cfg80211`/`mac80211` stack (any normal Wi-Fi).
- The yeet daemon (installed above) handles the privileged BPF load.

## Honest caveats

> [!NOTE]
> - A connected interface only hears **its own channel** plus whatever brief
>   scans touch — so the spectrum/AP list fill in as scans run, and live
>   per-frame traffic is mostly your channel. A full-band survey would need
>   monitor mode + channel hopping.
> - It counts **frames, not bytes** — "activity" is frame count, not airtime.
> - TX rate / retries aren't captured (that's a separate `tx_status` hook).
> - The `fentry` targets are stable in practice but not a kernel ABI; exact
>   data depends on your Wi-Fi driver.

## Building from source

```sh
make          # generates include/vmlinux.h from your kernel, builds bin/airtop.bpf.o
make vmlinux  # force-refresh the kernel type header
make clean    # remove the compiled object
```

Needs `clang` (BPF target) and `bpftool`; install your distro's `libbpf` /
`libbpf-dev` for the BPF headers. The generated `include/vmlinux.h` and `bin/`
are gitignored.

## Recording the demo

The GIF is produced with [VHS](https://github.com/charmbracelet/vhs) from
`assets/airtop.tape`:

```sh
vhs assets/airtop.tape       # -> assets/airtop.gif
```

It launches airtop off-camera so the GIF opens on the live dashboard. Kick off
Wi-Fi scans in another shell while recording to fill the spectrum and AP list.

## License

The BPF program is GPL (`SEC("license") = "GPL"`), as required by the kernel
helpers it uses.
