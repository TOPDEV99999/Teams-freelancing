"""Process-wide singletons."""
from .services.generation import GenerationService
from .services.submission_queue import SubmissionQueue
from .ws.connection_manager import manager

generation = GenerationService(manager)
submissions = SubmissionQueue(manager)
