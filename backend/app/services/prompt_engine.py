"""Prompt template engine for TalkTo.

Loads markdown templates from the prompts/ directory and renders them
with Jinja2, supporting composable blocks.
"""

from pathlib import Path

from jinja2 import Environment, FileSystemLoader

from backend.app.config import PROMPTS_DIR


class PromptEngine:
    """Renders prompt templates with variable substitution."""

    def __init__(self, prompts_dir: Path | None = None) -> None:
        self._dir = prompts_dir or PROMPTS_DIR
        self._env = Environment(
            loader=FileSystemLoader(str(self._dir)),
            keep_trailing_newline=True,
        )

    def render(self, template_name: str, **kwargs: str) -> str:
        """Render a single template file with variables."""
        template = self._env.get_template(template_name)
        return template.render(**kwargs)

    def render_master_prompt(
        self,
        agent_name: str,
        agent_type: str,
        project_name: str,
        project_channel: str,
        operator_name: str = "",
        operator_display_name: str = "",
        operator_about: str = "",
        operator_instructions: str = "",
    ) -> str:
        """Render the master prompt sent to agents on registration."""
        return self.render(
            "master_prompt.md",
            agent_name=agent_name,
            agent_type=agent_type,
            project_name=project_name,
            project_channel=project_channel,
            operator_name=operator_name,
            operator_display_name=operator_display_name,
            operator_about=operator_about,
            operator_instructions=operator_instructions,
        )

    def render_registration_rules(
        self,
        agent_name: str,
        project_channel: str,
    ) -> str:
        """Render the text agents inject into their rules files."""
        return self.render(
            "registration_rules.md",
            agent_name=agent_name,
            project_channel=project_channel,
        )

    def get_feature_requests(self) -> str:
        """Load the feature requests markdown (no templating needed)."""
        path = self._dir / "feature_requests.md"
        return path.read_text()


# Singleton instance
prompt_engine = PromptEngine()
