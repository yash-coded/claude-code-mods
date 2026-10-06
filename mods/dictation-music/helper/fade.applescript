-- Fades the system output volume around a pause or a play, then leaves the
-- volume where it was. Usage: osascript fade.applescript out|in <media-control> <ms>
--   out: ramp down, pause, put the volume back
--   in:  silence, play, ramp up
-- Outputs whose volume macOS can't set (some HDMI and multi-output devices),
-- and muted ones, just pause or play.

on run argv
	set mode to item 1 of argv
	set media to quoted form of (item 2 of argv)
	set ms to (item 3 of argv) as integer
	set settings to get volume settings
	set target to output volume of settings
	if target is missing value or output muted of settings or target is 0 then
		if mode is "out" then
			do shell script media & " pause"
		else
			do shell script media & " play"
		end if
		return
	end if

	set steps to 15
	set gap to ms / 1000 / steps
	try
		if mode is "out" then
			repeat with i from 1 to steps
				set volume output volume (round (target * (steps - i) / steps))
				delay gap
			end repeat
			do shell script media & " pause"
			-- Let the player stop before the volume comes back.
			delay 0.3
		else
			set volume output volume 0
			do shell script media & " play"
			repeat with i from 1 to steps
				delay gap
				set volume output volume (round (target * i / steps))
			end repeat
		end if
	end try
	set volume output volume target
end run
