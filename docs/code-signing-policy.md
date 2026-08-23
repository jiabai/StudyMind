# StudyMind Code Signing Policy

Free code signing provided by SignPath.io, certificate by SignPath Foundation.

## Scope

This policy applies to StudyMind desktop releases distributed through the [GitHub Releases](https://github.com/jiabai/StudyMind/releases) page. StudyMind is open source under the [MIT License](../LICENSE).

SignPath-signed artifacts are built from the public [StudyMind source repository](https://github.com/jiabai/StudyMind) using the [desktop release workflow](../.github/workflows/desktop-release.yml). Each release must be manually approved before it is submitted for signing.

## Project roles

StudyMind is currently maintained by one person:

- Committer and reviewer: [Aaron Bi](https://github.com/jiabai)
- Approver: [Aaron Bi](https://github.com/jiabai)

Changes to the source repository, build scripts, and CI configuration are part of the review scope. Release approval is performed by the approver listed above.

## Privacy

StudyMind is a local-first desktop application for importing local audio and video, producing timestamped transcripts, and generating study notes. Local media and generated transcripts are processed by the application on the user’s device. AI-assisted synthesis may use the local or cloud LLM endpoint selected by the user.

The public privacy policy is available at <https://studymind.8xf.pro/privacy>.

## Release provenance

Windows and macOS release artifacts are built by GitHub Actions from the public repository. The release workflow packages the application and its bundled runtime dependencies; source code, build scripts, and CI configuration are included in the provenance review.
