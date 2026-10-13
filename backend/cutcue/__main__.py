"""Run the Menapoly Cut Cue API server: ``python -m cutcue``."""
import ipaddress
import logging
import sys

import uvicorn

from .config import settings


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    try:
        loopback = ipaddress.ip_address(settings.host).is_loopback
    except ValueError:
        loopback = settings.host == "localhost"
    if not loopback and not settings.password:
        sys.exit("Refusing to listen on a non-local address without CUTCUE_PASSWORD set.")
    reload = "--reload" in sys.argv
    uvicorn.run("cutcue.main:create_app", factory=True, host=settings.host, port=settings.port, reload=reload,
                reload_dirs=["cutcue"] if reload else None)


if __name__ == "__main__":
    main()
