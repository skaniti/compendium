"""LLM service for model interactions.

This module provides a unified interface for LLM calls, supporting
multiple providers (OpenAI, Anthropic, HuggingFace) with consistent error handling.

Milestone 3: Basic model comparison experiments with metrics tracking.
"""

import asyncio
import json
import logging
import time
from typing import Any, Optional, Literal
from enum import Enum

from pydantic import BaseModel
import httpx

from openai.types.chat import ChatCompletionMessageToolCall

from backend.config.settings import settings
from backend.services.skip_categories import SKIP_CATEGORIES, SKIP_CATEGORY_IDS
from backend.services.content_fetcher import (
    fetch_wikipedia_content,
    fetch_youtube_metadata,
    fetch_stackoverflow_question,
    fetch_arxiv_paper,
    get_extracted_content,
    ContentFetchError,
)

logger = logging.getLogger(__name__)


class LLMProvider(str, Enum):
    """Supported LLM providers."""

    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    HUGGINGFACE = "huggingface"


# Model name to provider mapping
MODEL_PROVIDERS = {
    # OpenAI models
    "gpt-4o": LLMProvider.OPENAI,
    "gpt-4o-mini": LLMProvider.OPENAI,
    "gpt-4-turbo": LLMProvider.OPENAI,
    "gpt-3.5-turbo": LLMProvider.OPENAI,
    # Anthropic models (updated Feb 2025)
    "claude-sonnet-4-5-20250514": LLMProvider.ANTHROPIC,  # Claude Sonnet 4.5
    "claude-haiku-4-5-20251001": LLMProvider.ANTHROPIC,  # Claude 4.5 Haiku
    "claude-3-5-sonnet-20241022": LLMProvider.ANTHROPIC,  # Legacy - may be deprecated
    # HuggingFace models (via Inference API) - using openly available models
    "mistralai/Mistral-7B-Instruct-v0.3": LLMProvider.HUGGINGFACE,
    "mistralai/Mixtral-8x7B-Instruct-v0.1": LLMProvider.HUGGINGFACE,
    "Qwen/Qwen2.5-72B-Instruct": LLMProvider.HUGGINGFACE,
}

# Model aliases for convenience
MODEL_ALIASES = {
    "claude-4.5-sonnet": "claude-sonnet-4-5-20250514",
    "claude-3.5-sonnet": "claude-3-5-sonnet-20241022",
    "claude-3.5-haiku": "claude-haiku-4-5-20251001",
    "mistral-7b": "mistralai/Mistral-7B-Instruct-v0.3",
    "mixtral": "mistralai/Mixtral-8x7B-Instruct-v0.1",
    "qwen-72b": "Qwen/Qwen2.5-72B-Instruct",
}

# OpenAI Batch API applies a flat 50% discount to both input and output
# tokens on eligible chat completions (see platform.openai.com/docs/guides/batch).
# Applied multiplicatively against MODEL_PRICING when computing cost for a
# batch-mode response — keeping the pricing table itself authoritative for
# realtime calls.
BATCH_API_DISCOUNT = 0.50

# Pricing per 1K tokens (as of Feb 2025)
MODEL_PRICING = {
    "gpt-4o": {"input": 0.0025, "output": 0.01},
    "gpt-4o-mini": {"input": 0.00015, "output": 0.0006},
    "gpt-3.5-turbo": {"input": 0.0005, "output": 0.0015},
    "claude-sonnet-4-5-20250514": {"input": 0.003, "output": 0.015},
    "claude-haiku-4-5-20251001": {"input": 0.0008, "output": 0.004},
    # HuggingFace Inference API - free tier
    "mistralai/Mistral-7B-Instruct-v0.3": {"input": 0.0, "output": 0.0},
    "mistralai/Mixtral-8x7B-Instruct-v0.1": {"input": 0.0, "output": 0.0},
    "Qwen/Qwen2.5-72B-Instruct": {"input": 0.0, "output": 0.0},
}


# -- Batch API (used by :meth:`LLMService.submit_batch` et al.) ---------------

BATCH_ENDPOINT = "/v1/chat/completions"
BATCH_TERMINAL_STATUSES = {"completed", "failed", "expired", "cancelled"}


class BatchSubmissionError(RuntimeError):
    """Raised when a batch cannot be submitted (file upload or create failure)."""


class BatchTimeoutError(RuntimeError):
    """Raised if a batch doesn't reach a terminal state inside the poll timeout."""


class BatchFailedError(RuntimeError):
    """Raised when a batch reaches a terminal state other than ``completed``."""


class LLMResponse(BaseModel):
    """Standardized LLM response with metrics."""

    content: str
    model: str
    provider: LLMProvider
    input_tokens: int
    output_tokens: int
    total_tokens: int
    latency_ms: float
    cost_usd: float = 0.0

    def __str__(self) -> str:
        return self.content


class LLMService:
    """
    Unified LLM service supporting multiple providers.

    Usage:
        service = LLMService()
        response = await service.complete(
            prompt="Summarize this article...",
            model="gpt-4o",
        )
        print(f"Response: {response.content}")
        print(f"Latency: {response.latency_ms}ms")
        print(f"Cost: ${response.cost_usd:.4f}")
    """

    def __init__(self):
        """Initialize LLM clients."""
        self._openai_client = None
        self._anthropic_client = None
        self._hf_headers = None

        # Quiet LangSmith trace-ingest 429 warnings (free-tier cap noise).
        # Idempotent; safe to call from every LLMService init.
        from backend.services.langsmith_safety import (
            quiet_trace_ingest_warnings,
            safe_wrap_anthropic,
            safe_wrap_openai,
        )

        quiet_trace_ingest_warnings()

        # Initialize OpenAI client
        if settings.has_openai:
            from openai import AsyncOpenAI

            client = AsyncOpenAI(api_key=settings.openai_api_key)
            if settings.langchain_tracing_v2 and settings.langchain_api_key:
                client = safe_wrap_openai(client)
            self._openai_client = client

        # Initialize Anthropic client
        if settings.has_anthropic:
            from anthropic import AsyncAnthropic

            client = AsyncAnthropic(api_key=settings.anthropic_api_key)
            if settings.langchain_tracing_v2 and settings.langchain_api_key:
                client = safe_wrap_anthropic(client)
            self._anthropic_client = client

        # Initialize HuggingFace headers
        if settings.has_huggingface:
            self._hf_headers = {
                "Authorization": f"Bearer {settings.hf_token}",
                "Content-Type": "application/json",
            }

    def _resolve_model(self, model: str) -> str:
        """Resolve model alias to full model name."""
        return MODEL_ALIASES.get(model, model)

    def _get_provider(self, model: str) -> LLMProvider:
        """Get provider for a model."""
        model = self._resolve_model(model)
        if model not in MODEL_PROVIDERS:
            raise ValueError(f"Unknown model: {model}. Available: {list(MODEL_PROVIDERS.keys())}")
        return MODEL_PROVIDERS[model]

    def _calculate_cost(self, model: str, input_tokens: int, output_tokens: int) -> float:
        """Calculate cost for a completion."""
        model = self._resolve_model(model)
        if model not in MODEL_PRICING:
            return 0.0
        pricing = MODEL_PRICING[model]
        return (input_tokens * pricing["input"] + output_tokens * pricing["output"]) / 1000

    async def complete(
        self,
        prompt: str,
        model: Optional[str] = None,
        temperature: float = 0.7,
        max_tokens: int = 1000,
        system_prompt: Optional[str] = None,
        seed: Optional[int] = None,
        response_format: Optional[str] = None,
    ) -> LLMResponse:
        """
        Generate a completion from the specified model.

        Args:
            prompt: User prompt
            model: Model identifier (e.g., "gpt-4o", "claude-3.5-sonnet")
            temperature: Sampling temperature (0-1)
            max_tokens: Maximum tokens to generate
            system_prompt: Optional system prompt
            seed: Optional seed for OpenAI's best-effort determinism (ignored
                for non-OpenAI providers).
            response_format: "json_object" activates OpenAI JSON mode — the
                model is structurally constrained to emit valid JSON (batch B
                4c: parse failures stop being a failure mode for JSON-shaped
                calls). Ignored with a warning for non-OpenAI providers. The
                prompt must still mention JSON (OpenAI API requirement).

        Returns:
            Standardized LLM response with metrics
        """
        model = model or settings.default_inference_model
        model = self._resolve_model(model)
        provider = self._get_provider(model)

        if response_format and provider != LLMProvider.OPENAI:
            logger.warning(
                f"response_format={response_format!r} ignored for provider "
                f"{provider} (OpenAI-only)"
            )
            response_format = None

        start_time = time.perf_counter()

        if provider == LLMProvider.OPENAI:
            response = await self._complete_openai(
                prompt, model, temperature, max_tokens, system_prompt,
                seed=seed, response_format=response_format,
            )
        elif provider == LLMProvider.ANTHROPIC:
            response = await self._complete_anthropic(
                prompt, model, temperature, max_tokens, system_prompt
            )
        elif provider == LLMProvider.HUGGINGFACE:
            response = await self._complete_huggingface(
                prompt, model, temperature, max_tokens, system_prompt
            )
        else:
            raise ValueError(f"Unsupported provider: {provider}")

        latency_ms = (time.perf_counter() - start_time) * 1000
        response.latency_ms = latency_ms
        response.cost_usd = self._calculate_cost(
            model, response.input_tokens, response.output_tokens
        )

        return response

    async def _complete_openai(
        self,
        prompt: str,
        model: str,
        temperature: float,
        max_tokens: int,
        system_prompt: Optional[str],
        seed: Optional[int] = None,
        response_format: Optional[str] = None,
    ) -> LLMResponse:
        """Generate completion via OpenAI API."""
        if not self._openai_client:
            raise RuntimeError("OpenAI client not initialized. Set OPENAI_API_KEY.")

        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt})

        kwargs: dict = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if seed is not None:
            kwargs["seed"] = seed
        if response_format is not None:
            kwargs["response_format"] = {"type": response_format}
        response = await self._openai_client.chat.completions.create(**kwargs)

        return LLMResponse(
            content=response.choices[0].message.content or "",
            model=model,
            provider=LLMProvider.OPENAI,
            input_tokens=response.usage.prompt_tokens,
            output_tokens=response.usage.completion_tokens,
            total_tokens=response.usage.total_tokens,
            latency_ms=0,  # Will be set by caller
        )

    async def complete_vision(
        self,
        prompt: str,
        image_urls: list[str],
        model: str = "gpt-4o",
        detail: str = "low",
        temperature: float = 0.3,
        max_tokens: int = 300,
        system_prompt: Optional[str] = None,
    ) -> LLMResponse:
        """Generate completion with vision (image) input via OpenAI.

        Builds multimodal content blocks combining text and image URLs.
        Uses detail="low" by default (85 tokens/image, 9x cheaper than high).

        Args:
            prompt: Text prompt to accompany the images.
            image_urls: List of image URLs to include.
            model: Vision-capable model (must be OpenAI, e.g. gpt-4o).
            detail: Image detail level ("low" or "high").
            temperature: Sampling temperature.
            max_tokens: Maximum tokens in response.
            system_prompt: Optional system prompt.

        Returns:
            LLMResponse with content, token counts, and cost.
        """
        if not self._openai_client:
            raise RuntimeError("OpenAI client not initialized. Set OPENAI_API_KEY.")

        start_time = time.perf_counter()

        # Build multimodal content blocks
        content_blocks: list[dict] = [{"type": "text", "text": prompt}]
        for url in image_urls:
            content_blocks.append(
                {
                    "type": "image_url",
                    "image_url": {"url": url, "detail": detail},
                }
            )

        messages: list[dict] = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": content_blocks})

        response = await self._openai_client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
        )

        latency_ms = (time.perf_counter() - start_time) * 1000

        result = LLMResponse(
            content=response.choices[0].message.content or "",
            model=model,
            provider=LLMProvider.OPENAI,
            input_tokens=response.usage.prompt_tokens,
            output_tokens=response.usage.completion_tokens,
            total_tokens=response.usage.total_tokens,
            latency_ms=latency_ms,
        )
        result.cost_usd = self._calculate_cost(model, result.input_tokens, result.output_tokens)
        return result

    async def _complete_anthropic(
        self,
        prompt: str,
        model: str,
        temperature: float,
        max_tokens: int,
        system_prompt: Optional[str],
    ) -> LLMResponse:
        """Generate completion via Anthropic API."""
        if not self._anthropic_client:
            raise RuntimeError("Anthropic client not initialized. Set ANTHROPIC_API_KEY.")

        kwargs = {
            "model": model,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "messages": [{"role": "user", "content": prompt}],
        }
        if system_prompt:
            kwargs["system"] = system_prompt

        response = await self._anthropic_client.messages.create(**kwargs)

        return LLMResponse(
            content=response.content[0].text,
            model=model,
            provider=LLMProvider.ANTHROPIC,
            input_tokens=response.usage.input_tokens,
            output_tokens=response.usage.output_tokens,
            total_tokens=response.usage.input_tokens + response.usage.output_tokens,
            latency_ms=0,  # Will be set by caller
        )

    async def _complete_huggingface(
        self,
        prompt: str,
        model: str,
        temperature: float,
        max_tokens: int,
        system_prompt: Optional[str],
    ) -> LLMResponse:
        """Generate completion via HuggingFace Inference API."""
        if not self._hf_headers:
            raise RuntimeError("HuggingFace headers not set. Set HUGGINGFACE_API_KEY.")

        # Build prompt with system message if provided
        full_prompt = prompt
        if system_prompt:
            full_prompt = f"{system_prompt}\n\n{prompt}"

        # HuggingFace Inference API endpoint
        url = f"https://api-inference.huggingface.co/models/{model}"

        payload = {
            "inputs": full_prompt,
            "parameters": {
                "temperature": temperature,
                "max_new_tokens": max_tokens,
                "return_full_text": False,
            },
        }

        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(url, headers=self._hf_headers, json=payload)
            response.raise_for_status()
            result = response.json()

        # HuggingFace returns different formats depending on the model
        if isinstance(result, list) and len(result) > 0:
            generated_text = result[0].get("generated_text", "")
        else:
            generated_text = result.get("generated_text", "")

        # Estimate token counts (HF API doesn't always return them)
        input_tokens = len(prompt.split()) + (len(system_prompt.split()) if system_prompt else 0)
        output_tokens = len(generated_text.split())

        return LLMResponse(
            content=generated_text,
            model=model,
            provider=LLMProvider.HUGGINGFACE,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=input_tokens + output_tokens,
            latency_ms=0,  # Will be set by caller
        )

    # =========================================================================
    # Tool calling support
    # =========================================================================

    async def select_tool(
        self,
        prompt: str,
        tools: list[dict],
        model: Optional[str] = None,
        **kwargs,
    ) -> tuple[LLMResponse, Optional[list[dict]]]:
        """
        Perform a single LLM call to select a tool WITHOUT executing it.

        Unlike complete_with_tools, this does NOT execute the tool or make
        a follow-up API call. Returns only the LLM's tool selection decision.
        This is cheaper (1 API call vs 2) and gives the caller direct control
        over tool execution.

        Returns:
            Tuple of (response, tool_calls) where tool_calls contains the
            selected tool name and arguments, or None if no tool was chosen.
        """
        model = model or settings.default_inference_model
        model = self._resolve_model(model)
        provider = self._get_provider(model)

        start_time = time.perf_counter()

        if provider == LLMProvider.OPENAI:
            response, tool_calls = await self._select_tool_openai(prompt, tools, model, **kwargs)
        elif provider == LLMProvider.ANTHROPIC:
            response, tool_calls = await self._select_tool_anthropic(prompt, tools, model, **kwargs)
        else:
            raise ValueError(f"Tool calling not supported for provider: {provider}")

        latency_ms = (time.perf_counter() - start_time) * 1000
        response.latency_ms = latency_ms
        response.cost_usd = self._calculate_cost(
            model, response.input_tokens, response.output_tokens
        )

        return response, tool_calls

    async def _select_tool_openai(
        self,
        prompt: str,
        tools: list[dict],
        model: str,
        **kwargs,
    ) -> tuple[LLMResponse, Optional[list[dict]]]:
        """Single OpenAI call to get tool selection only."""
        if not self._openai_client:
            raise RuntimeError("OpenAI client not initialized. Set OPENAI_API_KEY.")

        messages = []
        if kwargs.get("system_prompt"):
            messages.append({"role": "system", "content": kwargs["system_prompt"]})
        messages.append({"role": "user", "content": prompt})

        response = await self._openai_client.chat.completions.create(
            model=model,
            messages=messages,
            tools=tools,  # type: ignore[arg-type]
            temperature=kwargs.get("temperature", 0.0),
            max_tokens=kwargs.get("max_tokens", 200),
        )

        msg = response.choices[0].message
        usage = response.usage
        assert usage is not None

        tool_calls_list = None
        if msg.tool_calls:
            tool_calls_list = [
                {
                    "name": tc.function.name,
                    "arguments": json.loads(tc.function.arguments),
                    "id": tc.id,
                }
                for tc in msg.tool_calls
                if isinstance(tc, ChatCompletionMessageToolCall)
            ]

        return (
            LLMResponse(
                content=msg.content or "",
                model=model,
                provider=LLMProvider.OPENAI,
                input_tokens=usage.prompt_tokens,
                output_tokens=usage.completion_tokens,
                total_tokens=usage.total_tokens,
                latency_ms=0,
            ),
            tool_calls_list,
        )

    async def _select_tool_anthropic(
        self,
        prompt: str,
        tools: list[dict],
        model: str,
        **kwargs,
    ) -> tuple[LLMResponse, Optional[list[dict]]]:
        """Single Anthropic call to get tool selection only."""
        if not self._anthropic_client:
            raise RuntimeError("Anthropic client not initialized. Set ANTHROPIC_API_KEY.")

        anthropic_tools = [
            {
                "name": t["function"]["name"],
                "description": t["function"]["description"],
                "input_schema": t["function"]["parameters"],
            }
            for t in tools
        ]

        api_kwargs = {
            "model": model,
            "max_tokens": kwargs.get("max_tokens", 200),
            "temperature": kwargs.get("temperature", 0.0),
            "messages": [{"role": "user", "content": prompt}],
            "tools": anthropic_tools,
        }
        if kwargs.get("system_prompt"):
            api_kwargs["system"] = kwargs["system_prompt"]

        response = await self._anthropic_client.messages.create(**api_kwargs)

        tool_use_blocks = [b for b in response.content if b.type == "tool_use"]

        tool_calls_list = None
        if tool_use_blocks:
            tool_calls_list = [
                {
                    "name": b.name,
                    "arguments": b.input,
                    "id": b.id,
                }
                for b in tool_use_blocks
            ]

        text_content = "".join(b.text for b in response.content if b.type == "text")

        return (
            LLMResponse(
                content=text_content,
                model=model,
                provider=LLMProvider.ANTHROPIC,
                input_tokens=response.usage.input_tokens,
                output_tokens=response.usage.output_tokens,
                total_tokens=response.usage.input_tokens + response.usage.output_tokens,
                latency_ms=0,
            ),
            tool_calls_list,
        )

    async def _complete_with_tools_openai(
        self,
        prompt: str,
        tools: list[dict],
        model: str,
        **kwargs,
    ) -> tuple[LLMResponse, Optional[list[dict]]]:
        """Generate a tool-calling completion via OpenAI API."""
        if not self._openai_client:
            raise RuntimeError("OpenAI client not initialized. Set OPENAI_API_KEY.")

        messages = []
        if kwargs.get("system_prompt"):
            messages.append({"role": "system", "content": kwargs["system_prompt"]})
        messages.append({"role": "user", "content": prompt})

        response = await self._openai_client.chat.completions.create(
            model=model,
            messages=messages,
            tools=tools,  # type: ignore[arg-type]
            temperature=kwargs.get("temperature", 0.7),
            max_tokens=kwargs.get("max_tokens", 1000),
        )

        response_message = response.choices[0].message
        usage = response.usage
        assert usage is not None, "OpenAI response missing usage data"
        total_input = usage.prompt_tokens
        total_output = usage.completion_tokens

        # No tool calls — return the response directly
        if not response_message.tool_calls:
            return (
                LLMResponse(
                    content=response_message.content or "",
                    model=model,
                    provider=LLMProvider.OPENAI,
                    input_tokens=total_input,
                    output_tokens=total_output,
                    total_tokens=total_input + total_output,
                    latency_ms=0,
                ),
                None,
            )

        # Tool calls present — execute them and make a follow-up call
        messages.append(response_message)  # type: ignore[arg-type]

        tool_calls_list: list[dict[str, Any]] = [
            {
                "name": tc.function.name,
                "arguments": json.loads(tc.function.arguments),
                "id": tc.id,
            }
            for tc in response_message.tool_calls
            if isinstance(tc, ChatCompletionMessageToolCall)
        ]

        for tc in response_message.tool_calls:
            if not isinstance(tc, ChatCompletionMessageToolCall):
                continue
            name = tc.function.name
            arguments = json.loads(tc.function.arguments)
            result_str = await _execute_tool(name, arguments)
            messages.append(
                {
                    "role": "tool",
                    "content": result_str,
                    "tool_call_id": tc.id,
                }
            )

        # Second API call with tool results
        second_response = await self._openai_client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=kwargs.get("temperature", 0.7),
            max_tokens=kwargs.get("max_tokens", 1000),
        )

        usage2 = second_response.usage
        assert usage2 is not None, "OpenAI response missing usage data"
        total_input += usage2.prompt_tokens
        total_output += usage2.completion_tokens

        return (
            LLMResponse(
                content=second_response.choices[0].message.content or "",
                model=model,
                provider=LLMProvider.OPENAI,
                input_tokens=total_input,
                output_tokens=total_output,
                total_tokens=total_input + total_output,
                latency_ms=0,
            ),
            tool_calls_list,
        )

    async def _complete_with_tools_anthropic(
        self,
        prompt: str,
        tools: list[dict],
        model: str,
        **kwargs,
    ) -> tuple[LLMResponse, Optional[list[dict]]]:
        """Generate a tool-calling completion via Anthropic API."""
        if not self._anthropic_client:
            raise RuntimeError("Anthropic client not initialized. Set ANTHROPIC_API_KEY.")

        # Convert OpenAI tool format to Anthropic format
        anthropic_tools = [
            {
                "name": t["function"]["name"],
                "description": t["function"]["description"],
                "input_schema": t["function"]["parameters"],
            }
            for t in tools
        ]

        api_kwargs = {
            "model": model,
            "max_tokens": kwargs.get("max_tokens", 1000),
            "temperature": kwargs.get("temperature", 0.7),
            "messages": [{"role": "user", "content": prompt}],
            "tools": anthropic_tools,
        }
        if kwargs.get("system_prompt"):
            api_kwargs["system"] = kwargs["system_prompt"]

        response = await self._anthropic_client.messages.create(**api_kwargs)

        total_input = response.usage.input_tokens
        total_output = response.usage.output_tokens

        # Check for tool_use blocks
        tool_use_blocks = [block for block in response.content if block.type == "tool_use"]

        # No tool calls — extract text and return
        if not tool_use_blocks:
            text_content = "".join(block.text for block in response.content if block.type == "text")
            return (
                LLMResponse(
                    content=text_content,
                    model=model,
                    provider=LLMProvider.ANTHROPIC,
                    input_tokens=total_input,
                    output_tokens=total_output,
                    total_tokens=total_input + total_output,
                    latency_ms=0,
                ),
                None,
            )

        # Tool calls present — execute and follow up
        tool_calls_list = [
            {
                "name": block.name,
                "arguments": block.input,
                "id": block.id,
            }
            for block in tool_use_blocks
        ]

        results = []
        for block in tool_use_blocks:
            result_str = await _execute_tool(block.name, block.input)
            results.append(result_str)

        tool_results = [
            {"type": "tool_result", "tool_use_id": block.id, "content": result_str}
            for block, result_str in zip(tool_use_blocks, results)
        ]

        messages = [
            {"role": "user", "content": prompt},
            {"role": "assistant", "content": response.content},
            {"role": "user", "content": tool_results},
        ]

        # Second API call (Anthropic requires tools param again)
        second_api_kwargs = {
            "model": model,
            "max_tokens": kwargs.get("max_tokens", 1000),
            "temperature": kwargs.get("temperature", 0.7),
            "messages": messages,
            "tools": anthropic_tools,
        }
        if kwargs.get("system_prompt"):
            second_api_kwargs["system"] = kwargs["system_prompt"]

        second_response = await self._anthropic_client.messages.create(**second_api_kwargs)

        total_input += second_response.usage.input_tokens
        total_output += second_response.usage.output_tokens

        text_content = "".join(
            block.text for block in second_response.content if block.type == "text"
        )

        return (
            LLMResponse(
                content=text_content,
                model=model,
                provider=LLMProvider.ANTHROPIC,
                input_tokens=total_input,
                output_tokens=total_output,
                total_tokens=total_input + total_output,
                latency_ms=0,
            ),
            tool_calls_list,
        )

    # =========================================================================
    # OpenAI Batch API (Milestone 14, Phase 1 Step 2)
    # =========================================================================
    # OpenAI's Batch API takes a JSONL file of chat-completion requests,
    # returns a batch id, and completes within a 24h SLA at a 50% price
    # discount. It's the ideal transport for any work the user isn't waiting
    # on — in this project, cluster naming and supercluster assignment during
    # nightly maintenance (see docs/.../14_scale/report.md).

    async def submit_batch(
        self,
        requests: list[dict],
        *,
        metadata: dict | None = None,
    ) -> str:
        """Upload ``requests`` as a JSONL file and create a batch; return the batch id.

        Each request dict must have ``custom_id`` (stable unique key used to
        map responses back) and ``body`` (the chat-completion request body
        — ``model``, ``messages``, etc.). ``method`` and ``url`` are filled
        in automatically to ``POST /v1/chat/completions``.
        """
        if not self._openai_client:
            raise RuntimeError("OpenAI client not initialized. Set OPENAI_API_KEY.")
        if not requests:
            raise ValueError("submit_batch called with empty request list")

        # Build JSONL bytes. Each line is a single request envelope.
        lines: list[str] = []
        seen_ids: set[str] = set()
        for req in requests:
            custom_id = req["custom_id"]
            if custom_id in seen_ids:
                raise ValueError(f"duplicate custom_id in batch: {custom_id!r}")
            seen_ids.add(custom_id)
            envelope = {
                "custom_id": custom_id,
                "method": "POST",
                "url": BATCH_ENDPOINT,
                "body": req["body"],
            }
            lines.append(json.dumps(envelope, ensure_ascii=False))
        jsonl_bytes = ("\n".join(lines) + "\n").encode("utf-8")

        # Upload via Files API with purpose='batch'. The SDK accepts a
        # (filename, fileobj) tuple so the server sees a real filename.
        try:
            file_obj = await self._openai_client.files.create(
                file=("batch_input.jsonl", jsonl_bytes),
                purpose="batch",
            )
        except Exception as exc:
            raise BatchSubmissionError(f"batch file upload failed: {exc}") from exc

        try:
            batch = await self._openai_client.batches.create(
                input_file_id=file_obj.id,
                endpoint=BATCH_ENDPOINT,
                completion_window="24h",
                metadata=metadata or {},
            )
        except Exception as exc:
            raise BatchSubmissionError(f"batch create failed: {exc}") from exc

        return batch.id

    async def poll_batch(self, batch_id: str) -> dict:
        """Return a shallow dict of the batch's current state."""
        if not self._openai_client:
            raise RuntimeError("OpenAI client not initialized. Set OPENAI_API_KEY.")

        batch = await self._openai_client.batches.retrieve(batch_id)
        return {
            "id": batch.id,
            "status": batch.status,
            "output_file_id": getattr(batch, "output_file_id", None),
            "error_file_id": getattr(batch, "error_file_id", None),
            "request_counts": getattr(batch, "request_counts", None),
        }

    async def await_batch(
        self,
        batch_id: str,
        *,
        poll_interval: float = 10.0,
        timeout: float = 3600.0,
        model_for_pricing: str = "gpt-4o-mini",
    ) -> dict[str, dict]:
        """Block until ``batch_id`` reaches a terminal state, then return parsed results.

        On ``completed``: returns ``{custom_id: {"content": str,
        "prompt_tokens": int, "completion_tokens": int, "cost_usd": float,
        "status_code": int}}``. Cost is computed at batch-discounted
        pricing (:data:`BATCH_API_DISCOUNT`).

        Raises :class:`BatchTimeoutError` if the batch is still non-terminal
        after ``timeout`` seconds, or :class:`BatchFailedError` for a
        terminal non-completed status. Individual per-request failures
        surface as entries with ``status_code`` != 200 and empty
        ``content`` — callers decide how to handle them.
        """
        if not self._openai_client:
            raise RuntimeError("OpenAI client not initialized. Set OPENAI_API_KEY.")

        started = time.monotonic()
        state: dict = {}
        while True:
            state = await self.poll_batch(batch_id)
            status = state["status"]
            if status in BATCH_TERMINAL_STATUSES:
                break
            if time.monotonic() - started > timeout:
                raise BatchTimeoutError(
                    f"batch {batch_id} still {status!r} after {timeout:.0f}s"
                )
            await asyncio.sleep(poll_interval)

        if state["status"] != "completed":
            raise BatchFailedError(
                f"batch {batch_id} terminated as {state['status']!r}; "
                f"error_file_id={state.get('error_file_id')}"
            )

        output_file_id = state.get("output_file_id")
        if not output_file_id:
            raise BatchFailedError(f"batch {batch_id} completed with no output_file_id")

        content_obj = await self._openai_client.files.content(output_file_id)
        raw_text = (
            content_obj.text if hasattr(content_obj, "text") else content_obj.read().decode()
        )

        pricing = MODEL_PRICING.get(model_for_pricing, {"input": 0.0, "output": 0.0})
        results: dict[str, dict] = {}

        for line in raw_text.splitlines():
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            cid = obj.get("custom_id", "")
            response = obj.get("response") or {}
            status_code = response.get("status_code", 0)
            body = response.get("body") or {}

            if status_code == 200:
                choices = body.get("choices") or []
                content = (
                    choices[0].get("message", {}).get("content", "") if choices else ""
                )
                usage = body.get("usage") or {}
                pt = int(usage.get("prompt_tokens") or 0)
                ct = int(usage.get("completion_tokens") or 0)
                cost = (
                    (pt * pricing["input"] + ct * pricing["output"])
                    / 1000
                    * BATCH_API_DISCOUNT
                )
            else:
                content, pt, ct, cost = "", 0, 0, 0.0

            results[cid] = {
                "content": content,
                "prompt_tokens": pt,
                "completion_tokens": ct,
                "cost_usd": cost,
                "status_code": status_code,
            }

        return results

    async def complete_with_tools(
        self,
        prompt: str,
        tools: list[dict],
        model: Optional[str] = None,
        **kwargs,
    ) -> tuple[LLMResponse, Optional[list[dict]]]:
        """
        Generate a completion with tool/function calling.

        Args:
            prompt: User prompt
            tools: List of tool definitions
            model: Model identifier
            **kwargs: Additional completion parameters
                - system_prompt: Optional system prompt
                - temperature: Sampling temperature (default 0.7)
                - max_tokens: Maximum tokens (default 1000)

        Returns:
            Tuple of (response, tool_calls) where tool_calls is None
            if no tools were invoked.
        """
        model = model or settings.default_inference_model
        model = self._resolve_model(model)
        provider = self._get_provider(model)

        start_time = time.perf_counter()

        if provider == LLMProvider.OPENAI:
            response, tool_calls = await self._complete_with_tools_openai(
                prompt, tools, model, **kwargs
            )
        elif provider == LLMProvider.ANTHROPIC:
            response, tool_calls = await self._complete_with_tools_anthropic(
                prompt, tools, model, **kwargs
            )
        elif provider == LLMProvider.HUGGINGFACE:
            raise ValueError(
                "HuggingFace Inference API does not support tool calling. "
                "Use an OpenAI or Anthropic model instead."
            )
        else:
            raise ValueError(f"Unsupported provider: {provider}")

        latency_ms = (time.perf_counter() - start_time) * 1000
        response.latency_ms = latency_ms
        response.cost_usd = self._calculate_cost(
            model, response.input_tokens, response.output_tokens
        )

        return response, tool_calls


# =============================================================================
# Tool Definitions & Execution
# =============================================================================

CONTENT_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "fetch_wikipedia_content",
            "description": "Fetch structured content from a Wikipedia article. Use for any URL containing wikipedia.org.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "The full Wikipedia article URL (e.g., https://en.wikipedia.org/wiki/Black_hole)",
                    }
                },
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "fetch_youtube_metadata",
            "description": "Fetch metadata and transcript from a YouTube video. Use for any URL containing youtube.com or youtu.be.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "The full YouTube video URL (e.g., https://www.youtube.com/watch?v=dQw4w9WgXcQ)",
                    }
                },
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "fetch_stackoverflow_question",
            "description": "Fetch a Stack Overflow question including body, score, tags, and top answer. Use for any URL containing stackoverflow.com.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "The full Stack Overflow question URL (e.g., https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster)",
                    }
                },
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "fetch_arxiv_paper",
            "description": "Fetch metadata from an arXiv paper including title, abstract, authors, and categories. Use for any URL containing arxiv.org.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "The full arXiv paper URL (e.g., https://arxiv.org/abs/1706.03762)",
                    }
                },
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_extracted_content",
            "description": "Retrieve pre-extracted page content for any URL not covered by platform-specific tools. Use this for blogs, news articles, documentation, forums, and other general web pages.",
            "parameters": {
                "type": "object",
                "properties": {"url": {"type": "string", "description": "The page URL"}},
                "required": ["url"],
            },
        },
    },
]

TOOL_FUNCTIONS = {
    "fetch_wikipedia_content": fetch_wikipedia_content,
    "fetch_youtube_metadata": fetch_youtube_metadata,
    "fetch_stackoverflow_question": fetch_stackoverflow_question,
    "fetch_arxiv_paper": fetch_arxiv_paper,
    "get_extracted_content": get_extracted_content,
}


# =============================================================================
# Page Processing Tools (Use Cases D+C: Skip Gate + Content Depth)
# =============================================================================

PAGE_PROCESSING_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "skip_page",
            "description": (
                "Skip this page entirely — it is a disambiguation page, error page, "
                "login wall, search results page, cookie consent redirect, or "
                "content-free stub. The page has no substantive content worth "
                "including in the knowledge compendium."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "category": {
                        "type": "string",
                        "enum": list(SKIP_CATEGORY_IDS),
                        "description": "\n".join(f"{cid}: {desc}" for cid, _label, desc in SKIP_CATEGORIES),
                    },
                    "reason": {
                        "type": "string",
                        "description": "Short free-text detail (a few words) supporting the category",
                    },
                },
                "required": ["category", "reason"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "process_page",
            "description": (
                "Process this page — it has meaningful content worth including "
                "in the knowledge compendium. The page contains substantive "
                "information (article text, video content, Q&A, research paper)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "reasoning": {
                        "type": "string",
                        "description": "Brief reasoning for why this page has meaningful content",
                    }
                },
                "required": ["reasoning"],
            },
        },
    },
]


async def _execute_tool(name: str, arguments: dict) -> str:
    """Execute a tool function by name and return JSON result."""
    func = TOOL_FUNCTIONS.get(name)
    if func is None:
        return json.dumps({"error": f"Unknown tool: {name}"})

    try:
        result = await func(**arguments)
        return result.model_dump_json()
    except (ContentFetchError, Exception) as e:
        return json.dumps({"error": str(e)})


# =============================================================================
# LLM-as-Judge Evaluation
# =============================================================================


class EvaluationResult(BaseModel):
    """Result from LLM-as-judge evaluation."""

    task_type: str
    model_evaluated: str
    scores: dict[str, int]  # criterion -> score (1-5)
    average_score: float
    reasoning: str
    evaluator_model: str = "gpt-4o"


EVALUATION_PROMPTS = {
    "summarization": """You are evaluating a Wikipedia article summary. Rate on a scale of 1-5:

SUMMARY TO EVALUATE:
{output}

ORIGINAL ARTICLE (excerpt):
{input_context}

Rate these criteria (1=poor, 5=excellent):
1. Accuracy: Does it capture the key facts without errors?
2. Conciseness: Is it appropriately brief (2-3 sentences)?
3. Readability: Is it clear and engaging?

Respond in this exact format:
ACCURACY: [1-5]
CONCISENESS: [1-5]
READABILITY: [1-5]
REASONING: [Brief explanation of your ratings]""",
    "narrative": """You are evaluating a journey narrative - a summary of a browsing session.

NARRATIVE TO EVALUATE:
{output}

SESSION INFO:
Pages visited: {page_titles}
Duration: {duration} minutes

Rate these criteria (1=poor, 5=excellent):
1. Coherence: Does it flow logically?
2. Tone: Is it warm, playful, and curiosity-friendly (not corporate)?
3. Completeness: Does it capture the key threads of the journey?

Respond in this exact format:
COHERENCE: [1-5]
TONE: [1-5]
COMPLETENESS: [1-5]
REASONING: [Brief explanation of your ratings]""",
}


async def evaluate_with_llm(
    task_type: Literal["summarization", "narrative"],
    output: str,
    model_evaluated: str,
    service: LLMService,
    evaluator_model: str = "gpt-4o",
    **context,
) -> EvaluationResult:
    """
    Evaluate an LLM output using GPT-4o as a judge.

    Args:
        task_type: Type of task being evaluated
        output: The output to evaluate
        model_evaluated: Name of the model that produced the output
        service: LLMService instance
        evaluator_model: Model to use as judge (default: gpt-4o)
        **context: Additional context for the evaluation prompt

    Returns:
        EvaluationResult with scores and reasoning
    """
    if task_type not in EVALUATION_PROMPTS:
        raise ValueError(f"Unknown task type: {task_type}")

    prompt_template = EVALUATION_PROMPTS[task_type]
    prompt = prompt_template.format(output=output, **context)

    response = await service.complete(
        prompt=prompt,
        model=evaluator_model,
        temperature=0.3,  # Lower temperature for more consistent evaluation
        max_tokens=500,
    )

    # Parse the response
    lines = response.content.strip().split("\n")
    scores = {}
    reasoning = ""

    for line in lines:
        line = line.strip()
        if ":" in line:
            key, value = line.split(":", 1)
            key = key.strip().upper()
            value = value.strip()

            if key == "REASONING":
                reasoning = value
            elif key in [
                "ACCURACY",
                "CONCISENESS",
                "READABILITY",
                "COHERENCE",
                "TONE",
                "COMPLETENESS",
            ]:
                try:
                    scores[key.lower()] = int(value)
                except ValueError:
                    scores[key.lower()] = 3  # Default if parsing fails

    average_score = sum(scores.values()) / len(scores) if scores else 0.0

    return EvaluationResult(
        task_type=task_type,
        model_evaluated=model_evaluated,
        scores=scores,
        average_score=average_score,
        reasoning=reasoning,
        evaluator_model=evaluator_model,
    )


# Convenience function for listing available models
def list_available_models() -> dict[str, list[str]]:
    """List all available models by provider."""
    result = {"openai": [], "anthropic": [], "huggingface": []}
    for model, provider in MODEL_PROVIDERS.items():
        result[provider.value].append(model)
    return result


