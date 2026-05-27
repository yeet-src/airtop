# Records the airtop demo GIF with VHS (https://github.com/charmbracelet/vhs).
# Run from the repo root:   vhs assets/airtop.tape   ->   assets/airtop.gif
#
# Needs: vhs (+ ffmpeg, ttyd), the yeet daemon running, and a Wi-Fi card.
# Tip: kick off Wi-Fi scans in another shell while recording so the spectrum
# and AP list fill up on camera, e.g.:
#   while :; do nmcli dev wifi rescan 2>/dev/null; sleep 7; done

Output "assets/airtop.gif"

Set Shell      "bash"
Set FontSize   13
Set Width      1500
Set Height     1000
Set Padding    14
Set Framerate  24

# Launch airtop and let it warm up off-camera, so the GIF opens directly on
# the live dashboard instead of a blank prompt.
Hide
Type "yeet run https://github.com/yeet-src/airtop -- --anonymize"
Enter
Sleep 6s
Show

# Recording: the live dashboard.
Sleep 18s

Ctrl+C
Sleep 500ms
