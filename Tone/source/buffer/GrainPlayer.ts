import { Source, SourceOptions } from "../Source";
import { noOp } from "../../core/util/Interface";
import { ToneAudioBuffer } from "../../core/context/ToneAudioBuffer";
import { defaultArg, optionsFromArguments } from "../../core/util/Defaults";
import { Clock } from "../../core/clock/Clock";
import { Cents, Positive, Seconds, Time } from "../../core/type/Units";
import { ToneBufferSource } from "./ToneBufferSource";
import { intervalToFrequencyRatio } from "../../core/type/Conversions";
import { assertRange } from "../../core/util/Debug";

interface GrainPlayerOptions extends SourceOptions {
	onload: () => void;
	reverse: boolean;
	url?: ToneAudioBuffer | string | AudioBuffer;
	overlap: Seconds;
	grainSize: Seconds;
	playbackRate: Positive;
	detune: Cents;
	loop: boolean;
	loopStart: Time;
	loopEnd: Time;
}

/**
 * GrainPlayer implements [granular synthesis](https://en.wikipedia.org/wiki/Granular_synthesis).
 * Granular Synthesis enables you to adjust pitch and playback rate independently. The grainSize is the
 * amount of time each small chunk of audio is played for and the overlap is the
 * amount of crossfading transition time between successive grains.
 * @category Source
 */
export class GrainPlayer extends Source<GrainPlayerOptions> {

	readonly name: string = "GrainPlayer";

	/**
	 * The audio buffer belonging to the player.
	 */
	buffer: ToneAudioBuffer;

	/**
	 * Create a repeating tick to schedule the grains.
	 */
	private _clock: Clock;

	/**
	 * Internal loopStart value
	 */
	private _loopStart = 0;

	/**
	 * Internal loopStart value
	 */
	private _loopEnd = 0;

	/**
	 * All of the currently playing BufferSources
	 */
	private _activeSources: ToneBufferSource[] = [];

	/**
	 * Internal reference to the playback rate
	 */
	private _playbackRate: Positive;

	/**
	 * Internal grain size reference;
	 */
	private _grainSize: Seconds; 

	/**
	 * Internal overlap reference;
	 */
	private _overlap: Seconds; 

	/**
	 * Adjust the pitch independently of the playbackRate.
	 */
	detune: Cents;

	/**
	 * If the buffer should loop back to the loopStart when completed
	 */
	loop: boolean;
		
	/**
	 * @param url Either the AudioBuffer or the url from which to load the AudioBuffer
	 * @param onload The function to invoke when the buffer is loaded.
	 */
	constructor(url?: string | AudioBuffer | ToneAudioBuffer, onload?: () => void);
	constructor(options?: Partial<GrainPlayerOptions>);
	constructor() {

		super(optionsFromArguments(GrainPlayer.getDefaults(), arguments, ["url", "onload"]));
		const options = optionsFromArguments(GrainPlayer.getDefaults(), arguments, ["url", "onload"]);

		this.buffer = new ToneAudioBuffer({
			onload: options.onload,
			reverse: options.reverse,
			url: options.url,
		});
		this._clock = new Clock({
			context: this.context,
			callback: this._tick.bind(this), 
			frequency: 1 / options.grainSize
		});
		this._playbackRate = options.playbackRate;
		this._grainSize = options.grainSize;
		this._overlap = options.overlap;
		this.detune = options.detune;

		// setup
		this.overlap = options.overlap;
		this.loop = options.loop;
		this.playbackRate = options.playbackRate;
		this.grainSize = options.grainSize;
		this.loopStart = options.loopStart;
		this.loopEnd = options.loopEnd;
		this.reverse = options.reverse;
		this._clock.on("stop", this._onstop.bind(this));
	}

	static getDefaults(): GrainPlayerOptions {
		return Object.assign(Source.getDefaults(), {
			onload: noOp,
			overlap: 0.1,
			grainSize: 0.2,
			playbackRate: 1,
			detune: 0,
			loop: false,
			loopStart: 0,
			loopEnd: 0,
			reverse: false
		});
	}

	/**
	 * Internal start method
	 */
	protected _start(time?: Time, offset?: Time, duration?: Time): void {
		offset = defaultArg(offset, 0);
		offset = this.toSeconds(offset);
		time = this.toSeconds(time);

		const grainSize = 1 / this._clock.frequency.getValueAtTime(time);
		this._clock.start(time, offset / grainSize);

		if (duration) {
			this.stop(time + this.toSeconds(duration));
		}
	}

	/**
	 * Stop and then restart the player from the beginning (or offset)
	 * @param  time When the player should start.
	 * @param  offset The offset from the beginning of the sample to start at.
	 * @param  duration How long the sample should play. If no duration is given, 
	 * 					it will default to the full length of the sample (minus any offset)
	 */
	restart(time?: Time, offset?: Time, duration?: Time): this {
		time = this.toSeconds(time);
		if (this._state.getValueAtTime(time) === "started") {
			this._stop(time);
			this._start(time, offset, duration);
		}
		return this;
	}

	/**
	 * Internal stop method
	 */
	protected _stop(time?: Time): void {
		this._clock.stop(time);
	}

	/**
	 * Invoked when the clock is stopped
	 */
	private _onstop(time: Seconds): void {
		// stop the players
		this._activeSources.forEach((source) => {
			source.fadeOut = 0;
			source.stop(time);
		});
		this.onstop(this);
	}

	/**
	 * Invoked on each clock tick. scheduled a new grain at this time.
	 */
	private _tick(time: Seconds): void {
		// check if it should stop looping
		const ticks = this._clock.getTicksAtTime(time);
		const grainSize = 1 / this._clock.frequency.getValueAtTime(time);
		const offset = ticks * grainSize;
		this.log("offset", offset);

		if (!this.loop && offset > this.buffer.duration) {
			this.stop(time);
			return;
		}

		// at the beginning of the file, the fade in should be 0
		const fadeIn = offset < this._overlap ? 0 : this._overlap;

		// create a buffer source
		const source = new ToneBufferSource({
			context: this.context,
			buffer: this.buffer,
			fadeIn: fadeIn,
			fadeOut: this._overlap,
			loop: this.loop,
			loopStart: this._loopStart,
			loopEnd: this._loopEnd,
			// compute the playbackRate based on the detune
			playbackRate: intervalToFrequencyRatio(this.detune / 100)
		}).connect(this.output);

		source.start(time, this._grainSize * ticks);
		source.stop(time + this._grainSize / this.playbackRate);

		// add it to the active sources
		this._activeSources.push(source);
		// remove it when it's done
		source.onended = () => {
			const index = this._activeSources.indexOf(source);
			if (index !== -1) {
				this._activeSources.splice(index, 1);
			}
		};
	}

	/**
	 * The playback rate of the sample
	 */
	get playbackRate(): Positive {
		return this._playbackRate;
	}
	set playbackRate(rate) {
		assertRange(rate, 0.001);
		this._playbackRate = rate;
		this.grainSize = this._grainSize;
	}

	/**
	 * The loop start time.
	 */
	get loopStart(): Time {
		return this._loopStart;
	}
	set loopStart(time) {
		this._loopStart = this.toSeconds(time);
	}

	/**
	 * The loop end time.
	 */
	get loopEnd(): Time {
		return this._loopEnd;
	}
	set loopEnd(time) {
		this._loopEnd = this.toSeconds(time);
	}

	/**
	 * The direction the buffer should play in
	 */
	get reverse() {
		return this.buffer.reverse;
	}

	set reverse(rev) {
		this.buffer.reverse = rev;
	}

	/**
	 * The size of each chunk of audio that the
	 * buffer is chopped into and played back at.
	 */
	get grainSize(): Time {
		return this._grainSize;
	}
	set grainSize(size) {
		this._grainSize = this.toSeconds(size);
		this._clock.frequency.setValueAtTime(this._playbackRate / this._grainSize, this.now());
	}

	/**
	 * The duration of the cross-fade between successive grains.
	 */
	get overlap(): Time {
		return this._overlap;
	}
	set overlap(time) {
		this._overlap = this.toSeconds(time);
	}

	/**
	 * If all the buffer is loaded
	 */
	get loaded(): boolean {
		return this.buffer.loaded;
	}

	dispose(): this{
		super.dispose();
		this.buffer.dispose();
		this._clock.dispose();
		this._activeSources.forEach((source) => source.dispose());
		return this;
	}
}
