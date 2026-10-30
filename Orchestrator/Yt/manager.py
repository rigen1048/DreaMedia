from returns.result import Failure

import time

from Automation.yt_orchestration import orchestration
from Sql.delete import delete_entry
from Sql.get import (
    is_working,
    should_sync_today,
    get_working_subscriptions,
    get_due_subscriptions,
    has_due_subscriptions,
    has_working_subscriptions,
    next_sync,
    get_all_subscriptions
)


# Runtime-only blacklist of channel_ids that recently failed a fetch.
# Resets on process restart – never written to the DB.
Black_list: list[int] = []


def _filter_blacklist(data_structure):
    """Return only entries whose channel_id is not currently blacklisted."""
    return tuple(item for item in data_structure if item[1] not in Black_list)


def yt_sync():
    task = get_all_subscriptions()
    orchestrator(task)

def yt_start():
    while True:
        if is_working() or should_sync_today():
            yt_sync()
            continue

        if has_working_subscriptions():
            task = _filter_blacklist(get_working_subscriptions())
            if task:
                orchestrator(task)
            else:
                # Everything currently working is blacklisted → brief pause
                time.sleep(10)
            continue

        if has_due_subscriptions():
            task = _filter_blacklist(get_due_subscriptions())
            if task:
                orchestrator(task)
            else:
                time.sleep(10)
            continue

        # Nothing to do – sleep until the next scheduled sync
        now = int(time.time())
        next_ts = next_sync()
        wait = max(0, next_ts - now) # TODO COMPARE NEXT TS to NEXT sync
        time.sleep(wait)





def orchestrator(data_structure):
    """
    Run orchestration on each remaining entry.
    - On Deleted:*  → permanently remove via delete_entry
    - On Fetcher:*  → add channel_id to the runtime Black_list
    """
    for index, data in enumerate(data_structure):
        result = orchestration(*data)

        if isinstance(result, Failure):
            msg = result.failure()

            if msg in ("Deleted:Channel", "Deleted:PlayList"):
                # data[1] is channel_id (matches orchestration signature)
                delete_entry(data[1])

            elif msg.startswith("Fetcher:"):
                channel_id = data[1]
                if channel_id not in Black_list:
                    Black_list.append(channel_id)

        # Throttle between items (skip after the last one)
        if index != len(data_structure) - 1:
            time.sleep(10)




# Loop by design
# designed to be called 1 time at the start of startup of the server for pc/docker user
# also designed to be long lasting for rasberry pie deployment

"""
- Check if sync is active
    - if not check the date
    - Activate the Sync

- Checks if there is a working one
    - Send it the function
- Checks if there is any time passed one + Marked Working
    - Send it to the function
"""
