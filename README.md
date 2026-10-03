# BAMZOOKi Reloaded

[Play in your browser](https://dougathlon.github.io/BamzookiReloaded/)

An unofficial browser reconstruction of the original BAMZOOKi creature-building software. Build a Zook, author its movement, test it, and enter autonomous contests. This is a work in progress, not the original Windows program or a verified full reconstruction.

Use a desktop browser with WebGL2 and WebAssembly, at a window size of at least 800 × 600. Zooks and replays save to this browser on this device; export your work to keep an independent backup. There are no accounts or online leaderboards.

## Start playing

1. In the Zook Loader, choose **Try a walking Zook**. This loads an editable, nine-part tutorial creature.
2. Choose **Test**, place a target, or run one of the five provisional trials. Return to **Select** to alter its body and movement.
3. Open **Modules → Simulator**, pick a contest, and choose the Tutorial Walker or your current Zook for each contestant. All nine pack entries have provisional playable rules.
4. After a contest, save its replay and open **Modules → Motion Player**. Replays include both Zooks and moving arena objects, and support cameras, playback, looping, scrubbing, and export.

The creatures move autonomously according to their construction and movement settings; this is not a keyboard-controlled racing game.

In **Select**, drag a side of the selected part's translucent box to reshape it. The matching Width, Height or Length slider previews the change; release to apply it as one Undo step, or press Escape to cancel. Mirrored partners change together. The fixed-center drag projection is Provisional; sliders and right-click numeric entry are also available.

Use **File / system → Save** to store the current Zook locally. **Save As** creates a differently named copy without changing existing saves. The browser copy uses its new name in Passport; subsequent Save updates that copy. Export remains the way to keep a separate downloadable backup.

If another tab changes or deletes the saved Zook, Save stops and keeps your unsaved edits. Use **Save As** or **Export** to preserve them before reopening the stored version. Delete also checks that its preview is still current, and Repair stops if the library changes during its checks. If an older game tab can no longer save after this update, export its unsaved work and reload it; existing saved records are retained.

**New Zook** asks for a name before creating its root body. When New or Open would replace modified work, choose **Save**, **Don't Save**, or **Cancel**. A failed save or import keeps the current Zook open. Cancelling the New name prompt also keeps it open, including after choosing Save.

The Loader's **Sort** menu can rank each of the five trials. Historical metadata, current Provisional Play v2 and retained legacy v1 results are separate score sets; the caption identifies which one you are viewing. Higher speed/distance and lower Lap time come first, with missing or incompatible records last. This ordering is a reconstruction choice, not a recovered original algorithm. Sorting never changes the saved results.

The six historical example names retain their recovered catalog metadata, but their original bodies are not decoded. Gameplay marked **Provisional Play Mode** uses reconstruction rules and physics, not historically verified results. Legacy `.Zook` and `.bvz` files are not supported imports. Browser exports use distinct modern formats.

**Hologram** displays a static 3D construction preview in Passport and for validated **My Zooks** saves. Previewing a saved creature does not open it or change your current design. Camera, lighting and static pose are reconstruction choices; undecoded original examples do not receive invented previews.

## Disclaimer

This is an unofficial, non-commercial educational reconstruction, not affiliated with, endorsed by, or sponsored by the BBC, CBBC, Gameware, or the original creators. Original names and trademarks belong to their respective owners and identify the software being studied. This release contains newly implemented browser code, procedural visuals, and separately licensed open-source runtime dependencies; it does not distribute the original installers, executable program code, or extracted artwork. No claim of exact historical fidelity is made.

Third-party licenses are included in [THIRD_PARTY_NOTICES.txt](site/THIRD_PARTY_NOTICES.txt). Those licenses apply to their respective dependencies, not to the BAMZOOKi name or original material.

This repository contains only an audited static distribution and its deployment controls. Development records and source-reference material are not part of this release.
