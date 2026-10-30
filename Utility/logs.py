import logging
import time

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

# Force UTC for all timestamps
logging.Formatter.converter = time.gmtime

log = logging.getLogger("dreamedia")
