from typing import Optional

from pydantic import BaseModel


class Video(BaseModel):
    id: str
    title: str
    url: str
    published: str
    thumbnail: Optional[str] = None
