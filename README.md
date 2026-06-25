### tools we use:

    - nginx for https req and manage the domain
    - Grammy for telegram bot
    - 3x-ui for v2ay controlling
    - worker for schedule action for backup
    - api node server for vpn server controlling
    - winston loki & grafana for logging
    - mongodb for common info about user and config and service and panel
    - redis for user configs data info
    - nextjs for front and backend
    - github CI/CD for push
    - jest for test before push to production
    - docker comose for managing all things
    - git for managing app versions
    - extra payment system
    - use BullMQ for do create and update in Queue

### for managing in productin

    - push to the main run tests in pipline ci/cd
    - if every thing is okay create tag for last release in github
    - then push the tag the pipline will release it
    - then after release the the version history file should be append then version
    - then role back script should exists in server when it run
    - the histoy file should be read the get the perv version
    - then change the docker image version the re run docker for last version
    - an other ctroller scrpit to mange the rollback from develpment server
    - it should ssh to server then run the rollback script

    - if for example version v1.1.0 is bugged and released
    - fix the bug and change the version to v1.1.1 then release don't fix the pervios version
