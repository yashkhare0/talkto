"""Quirky agent name generator.

Produces unique, fun compound names like "cosmic-penguin" or "turbo-flamingo"
from two curated wordlists using SHA-256 hashing with UUID entropy.
"""

import hashlib
import uuid

_ADJECTIVES = [
    "bouncy",
    "bubbly",
    "buzzy",
    "chaotic",
    "cheeky",
    "chilly",
    "chunky",
    "clever",
    "cosmic",
    "cranky",
    "crispy",
    "crunchy",
    "cuddly",
    "daring",
    "dizzy",
    "dreamy",
    "dusty",
    "fancy",
    "fizzy",
    "flashy",
    "fluffy",
    "frosty",
    "funky",
    "fuzzy",
    "giddy",
    "glitchy",
    "groovy",
    "grumpy",
    "gusty",
    "happy",
    "jazzy",
    "jiggly",
    "jolly",
    "jumpy",
    "lazy",
    "lucky",
    "mellow",
    "mighty",
    "misty",
    "moody",
    "nifty",
    "noble",
    "peppy",
    "plucky",
    "punchy",
    "quirky",
    "rusty",
    "salty",
    "sassy",
    "shiny",
    "silent",
    "silly",
    "sleepy",
    "sneaky",
    "snowy",
    "speedy",
    "spicy",
    "stormy",
    "sunny",
    "swift",
    "tangy",
    "tiny",
    "toasty",
    "turbo",
    "twisty",
    "wacky",
    "witty",
    "wobbly",
    "zappy",
    "zesty",
]

_ANIMALS = [
    "alpaca",
    "axolotl",
    "badger",
    "bat",
    "beaver",
    "bison",
    "bunny",
    "capybara",
    "chameleon",
    "cheetah",
    "cobra",
    "corgi",
    "coyote",
    "crane",
    "crow",
    "dolphin",
    "donkey",
    "dragon",
    "eagle",
    "falcon",
    "ferret",
    "flamingo",
    "fox",
    "frog",
    "gecko",
    "goose",
    "hamster",
    "hawk",
    "hedgehog",
    "hippo",
    "hyena",
    "iguana",
    "jaguar",
    "koala",
    "lemur",
    "leopard",
    "llama",
    "lobster",
    "lynx",
    "mantis",
    "moose",
    "narwhal",
    "newt",
    "octopus",
    "otter",
    "owl",
    "panda",
    "parrot",
    "pelican",
    "penguin",
    "possum",
    "puffin",
    "quail",
    "rabbit",
    "raccoon",
    "raven",
    "salmon",
    "seal",
    "shark",
    "sloth",
    "sparrow",
    "squid",
    "tiger",
    "toucan",
    "turtle",
    "viper",
    "walrus",
    "wombat",
    "yak",
    "zebra",
]


def generate_name(seed: str) -> str:
    """Generate a fun compound name from a seed string.

    Args:
        seed: Any string.  Deterministic — same seed always gives the same name.

    Returns:
        A lowercase compound name like ``"cosmic-penguin"`` or ``"fuzzy-walrus"``.
    """
    h = hashlib.sha256(seed.encode()).digest()

    adj_idx = (h[0] << 8 | h[1]) % len(_ADJECTIVES)
    animal_idx = (h[2] << 8 | h[3]) % len(_ANIMALS)

    return f"{_ADJECTIVES[adj_idx]}-{_ANIMALS[animal_idx]}"


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
