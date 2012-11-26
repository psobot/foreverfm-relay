# Forever.fm Relay

by Peter Sobot (psobot.com) on November 26, 2012. Licensed under MIT.
[Live at forever.fm](http://forever.fm).


---
Forever.fm is a web app that provides an endless beatmatched radio stream of the hottest tracks on SoundCloud. Check out the [absurdly long blog post on its creation](http://petersobot.com/blog/introducing-forever-fm) or the [site itself](http://forever.fm). Check out the code above if you're interested in some learnin'.

This is its bandwidth relay - i.e.: if you want to help me out by sharing in the bandwidth costs. :)

##How to get started

    git clone https://github.com/psobot/foreverfm-relay
    cd foreverfm-relay
    npm install
    node relay.js start

##Important notes

Make sure you set the config variables (in the top of the script) properly before starting.
Incorrectly set parameters might cause you to wildly exceed your bandwidth caps.

##Getting credit

To show my thanks for those who give me free bandwidth, I'm putting a list of the bandwidth providers on the homepage of Forever.FM. The catch? It's all automatic. If you start a relay and have your `relay_provider` and `relay_attribution_link` config variables set properly, then the central server will automatically add your name and link to the list. Thanks for helping out!
