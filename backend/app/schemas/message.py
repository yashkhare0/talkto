from pydantic import BaseModel, Field


class MessageCreate(BaseModel):
    content: str = Field(min_length=1, max_length=32000, description="Message content (max 32KB)")
    mentions: list[str] | None = Field(
        default=None, max_length=50, description="Agent/user names being mentioned (max 50)"
    )


class MessageResponse(BaseModel):
    id: str
    channel_id: str
    sender_id: str
    sender_name: str | None = None
    sender_type: str | None = None
    content: str
    mentions: list[str] | None = None
    parent_id: str | None = None
    created_at: str
