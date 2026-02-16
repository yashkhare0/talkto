"""Quirky agent name generator.

Produces unique, pronounceable names from a seed string using SHA-256 hashing.
No hardcoded wordlists — names are built algorithmically from syllable patterns.

Pattern: CV-CV-CVC (open syllables + closed final) → e.g. "zepari", "vokun", "nibex"
"""

import hashlib
import uuid


# Phoneme sets tuned for pronounceability
_ONSETS = "bdfghjklmnprstvwz"  # 17 consonants
_VOWELS = "aeiou"  # 5 vowels
_CODAS = "nrsxl"  # 5 soft codas (final syllable only)


def generate_name(seed: str, syllables: int = 3) -> str:
    """Generate a pronounceable name from a seed string.

    Args:
        seed: Any string. Deterministic — same seed always produces the same name.
        syllables: Number of syllables (2-4). Default 3 → 5-7 char names.

    Returns:
        A lowercase pronounceable name like "vokari" or "nibex".
    """
    h = hashlib.sha256(seed.encode()).digest()

    name = ""
    for i in range(syllables):
        offset = i * 2
        # Consonant onset
        name += _ONSETS[h[offset] % len(_ONSETS)]
        # Vowel nucleus
        name += _VOWELS[h[offset + 1] % len(_VOWELS)]

    # Close the final syllable with a coda (~60% chance, based on hash)
    coda_byte = h[syllables * 2]
    if coda_byte % 5 != 0:  # 80% get a coda
        name += _CODAS[coda_byte % len(_CODAS)]

    return name


def generate_unique_name(project_name: str, agent_type: str, attempt: int = 0) -> str:
    """Generate a unique agent name for a new agent.

    Each call produces a different name thanks to random entropy.
    The attempt counter is a fallback for the astronomically unlikely
    case of a DB collision on agent_name.
    """
    entropy = uuid.uuid4().hex[:8]
    seed = f"{project_name}:{agent_type}:{entropy}:{attempt}"
    return generate_name(seed)


# The creator agent's fixed name
CREATOR_NAME = "the_creator"
