FROM node

RUN useradd --user-group --create-home --shell /bin/false app

WORKDIR /home/app

ADD index.js .
ADD package.json .

RUN npm install

USER app

CMD ["node", "index.js"]
