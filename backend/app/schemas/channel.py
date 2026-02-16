from pydantic import BaseModel, Field


class ChannelCreate(BaseModel):
    name: str = Field(
        min_length=1,
        max_length=80,
        pattern=r"^#?[a-z0-9][a-z0-9_-]*$",
        description="Channel name. Lowercase alphanumeric, hyphens, underscores. Auto-prefixed with #.",
    )


class ChannelResponse(BaseModel):
    id: str
    name: str
    type: str
    project_path: str | None = None
    created_by: str
    created_at: str


class ChannelListResponse(BaseModel):
    channels: list[ChannelResponse]
