from studymind_worker.resource_throttle import apply_process_throttle

apply_process_throttle()

from studymind_worker.cli import main  # noqa: E402  (env/priority must be set first)

if __name__ == "__main__":
    raise SystemExit(main())
